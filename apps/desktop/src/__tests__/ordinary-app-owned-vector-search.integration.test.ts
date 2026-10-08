// @vitest-environment node
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AGENT_HOST_PROTOCOL_VERSION, attachAgentHost } from '@brainstrike/agent-host';
import { ASSISTANT_PREFERENCES_STORE_VERSION } from '@brainstrike/app-state/stores/assistant-preferences-store-version';
import {
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  parseOpenRouterModelMetadata,
} from '@brainstrike/assistant-contract';
import { decodeHostRecord } from '@brainstrike/host-lease';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import { HomePage } from '../../e2e/page-objects/home-page';
import { ensureAssistantShellVisible } from '../../e2e/utils/layout-helpers';
import {
  type ModelProviderRequest,
  startModelProviderShim,
} from '../../e2e/utils/model-provider-shim';

const desktop = resolve(import.meta.dirname, '../..');
// Reuse the recorded public metadata fixture; no provider grant or inference.
const recordedModelMetadata = parseOpenRouterModelMetadata(
  JSON.parse(
    await readFile(
      new URL('./fixtures/openrouter-sonnet-4-6-model-metadata.json', import.meta.url),
      'utf8'
    )
  ),
  'anthropic/claude-sonnet-4.6',
  Date.parse('2026-10-07T05:07:09.516Z')
);

test('ordinary app-owned Root returns real hidden-renderer semantic and hybrid results', {
  timeout: getAdjustedTimeout('e2e'),
}, async () => {
  await qualifyVectorSearch();
});

async function providerPortRefused(baseUrl: string): Promise<boolean> {
  const url = new URL(baseUrl);
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (cause) => {
      socket.destroy();
      if ('code' in cause && cause.code === 'ECONNREFUSED') {
        resolve(true);
      } else {
        reject(cause);
      }
    });
  });
}

async function qualifyVectorSearch(): Promise<void> {
  const disposable = await mkdtemp(join(tmpdir(), 'brainstrike-m3-app-owned-vector-'));
  const profile = join(disposable, 'profiles/m3-vector-search');
  const evidence = `${disposable}-evidence`;
  const workspace = join(disposable, 'workspace');
  await mkdir(profile, { recursive: true });
  await mkdir(evidence);
  await mkdir(workspace);
  const searchLine = 'VECTORPROOF6724 SQLite readers isolate read-only queries from the writer.';
  await writeFile(join(workspace, 'vector-proof.md'), `# SQLite reader ownership\n${searchLine}\n`);
  await writeFile(
    join(workspace, 'unrelated-proof.md'),
    '# Orchard maintenance\nApples grow in an orchard. Pruning trees makes the fruit harvest easier.\n'
  );
  const providerRequests: ModelProviderRequest[] = [];
  const blockedExternalRequests: string[] = [];
  const runtimeAssetRequests: { url: string; sha256: string }[] = [];
  let modelAssets: Awaited<ReturnType<typeof copyExistingModelCache>> = [];
  let workspaceRootId: string | undefined;
  let activeThreadId: string | undefined;
  let application: ElectronApplication | undefined;
  let observedPage: Page | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const closeOnce = (): Promise<void> => {
    cleanupPromise ??= closeResources();
    return cleanupPromise;
  };
  let client: Awaited<ReturnType<typeof attachAgentHost>> | undefined;
  let failure: unknown;
  const errors: unknown[] = [];
  const outputs: string[] = [];
  const owners: { pid: number; start: string }[] = [];
  const capture = async (app: ElectronApplication): Promise<void> => {
    for (const { pid } of await app.evaluate(({ app }) => app.getAppMetrics())) {
      const start = processStartTime(pid);
      if (start && !owners.some((owner) => owner.pid === pid && owner.start === start)) {
        owners.push({ pid, start });
      }
    }
    await writeFile(join(evidence, 'owners.json'), JSON.stringify(owners, null, 2));
  };
  const checkpoint = (phase: string): void => {
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), phase })}\n`);
  };
  const model = await startModelProviderShim((request) => {
    providerRequests.push(request);
    if (
      !['brainstrike_queryEmbeddingSpace', 'brainstrike_hybridSearch'].every((name) =>
        request.toolNames.includes(name)
      )
    ) {
      throw new Error('The ordinary default catalog did not admit both native retrieval tools');
    }
    if (!workspaceRootId) {
      throw new Error('The ordinary workspace has no authoritative root identity');
    }
    return {
      finalText: 'The actual semantic and hybrid SQLite results were received.',
      toolCallStages: [
        [
          {
            arguments: {
              limit: 2,
              maxChunks: 2,
              query: 'SQLite readers isolate read-only queries from the writer.',
              root: workspaceRootId,
            },
            name: 'brainstrike_queryEmbeddingSpace',
          },
        ],
        [
          {
            arguments: { limit: 2, query: searchLine, root: workspaceRootId },
            name: 'brainstrike_hybridSearch',
          },
        ],
      ],
    };
  });
  try {
    onTestFinished(async (context) => {
      const first = context.task.result?.errors?.[0];
      if (first && failure === undefined) {
        failure = new Error(first.message);
        await writeFile(
          join(evidence, 'first-failure.json'),
          JSON.stringify({ message: first.message, stack: first.stack }, null, 2)
        );
      }
      await closeOnce();
    });
    await writeFile(
      join(evidence, 'provider.json'),
      JSON.stringify({ baseUrl: model.baseUrl }, null, 2)
    );
    modelAssets = await copyExistingModelCache(disposable);
    await writeFile(join(evidence, 'model-assets.json'), JSON.stringify(modelAssets, null, 2));
    const runtimeAssets = await existingOrtAssets();
    await writeFile(
      join(evidence, 'ort-assets.json'),
      JSON.stringify([...runtimeAssets.values()], null, 2)
    );
    // Keep this search case independent of real or inherited MCP configuration.
    await mkdir(join(disposable, 'mcp'));
    await writeFile(join(disposable, 'mcp/mcp.config.json'), JSON.stringify({ servers: [] }));
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        name !== 'ELECTRON_RUN_AS_NODE' &&
        !/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|AWS_)/.test(name)
      ) {
        env[name] = value;
      }
    }
    Object.assign(env, {
      BRAINSTRIKE_DB_PROFILE: 'm3-vector-search',
      BRAINSTRIKE_DB_ROOT_PATH: disposable,
      BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
      BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES: '1',
      BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
      BRAINSTRIKE_E2E_USER_DATA_DIR: disposable,
      BRAINSTRIKE_OPENROUTER_API_KEY: 'owned-local-fixture-key',
      ELECTRON_IS_E2E_TEST: 'true',
      OPENROUTER_BASE_URL: model.baseUrl,
    });
    expect(RootLock.inspect(profile)).toBeNull();
    checkpoint('ordinary-search-launch-start');
    application = await _electron.launch({
      args: [
        join(desktop, 'dist/main.js'),
        '--test-mode',
        `--user-data-dir=${disposable}`,
        '--brainstrike-desktop-launch-mode=test-built',
      ],
      env,
      executablePath:
        process.env['BRAINSTRIKE_TEST_ELECTRON_EXEC_PATH'] ??
        join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    });
    const appProcess = application.process();
    const appStart = appProcess.pid && processStartTime(appProcess.pid);
    if (appProcess.pid && appStart) {
      owners.push({ pid: appProcess.pid, start: appStart });
    }
    appProcess.stdout?.on('data', (data: Buffer) => {
      outputs.push(data.toString());
      appendFileSync(join(evidence, 'output.log'), data);
    });
    appProcess.stderr?.on('data', (data: Buffer) => {
      outputs.push(data.toString());
      appendFileSync(join(evidence, 'output.log'), data);
    });
    await capture(application);
    await application.context().route(/^https?:\/\//u, async (route) => {
      const url = new URL(route.request().url());
      const installed = runtimeAssets.get(`${url.origin}${url.pathname}`);
      if (installed) {
        runtimeAssetRequests.push({ sha256: installed.sha256, url: installed.url });
        await route.fulfill({
          contentType: installed.contentType,
          headers: { 'access-control-allow-origin': '*' },
          path: installed.path,
        });
      } else if (
        url.hostname === '127.0.0.1' ||
        url.hostname === 'localhost' ||
        url.hostname === '[::1]'
      ) {
        await route.continue();
      } else {
        blockedExternalRequests.push(`${url.origin}${url.pathname}`);
        await route.abort('blockedbyclient');
      }
    });
    await application.context().route('**/assistant/openrouter-model?*', async (route) => {
      await route.fulfill({
        body: JSON.stringify({ freshness: 'live', metadata: recordedModelMetadata }),
        contentType: 'application/json',
      });
    });
    const runtime = await application.evaluate(() => ({
      arch: process.arch,
      versions: process.versions,
    }));
    const page = await application.firstWindow();
    observedPage = page;
    await ensureAssistantShellVisible(page);
    await page.getByRole('textbox', { name: 'Message input' }).waitFor();
    // Match the ordinary fixture's disposable model/preferences setup. This
    // enables an existing model, without seeding workspace/search/index rows.
    await page.evaluate(
      async ({ memory, version }) => {
        if (!(window.electronAPI?.db && 'storage' in window.electronAPI)) {
          throw new Error('The normal desktop DB/storage bridge is missing');
        }
        await window.electronAPI.db.query(
          'UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2',
          ['anthropic/claude-sonnet-4.6', 'openrouter']
        );
        localStorage.setItem(
          'assistant-preferences.v1',
          JSON.stringify({
            state: {
              modelsByProvider: { openrouter: 'anthropic/claude-sonnet-4.6' },
              providerSettings: {
                openrouter: {
                  agentInputTokenLimit: 24_000,
                  agentMaxSteps: 8,
                  maxOutputTokens: 900,
                  memoryLastMessages: 7,
                  temperature: 0.2,
                  workingMemoryEnabled: true,
                },
              },
              selectedModel: 'openrouter::anthropic/claude-sonnet-4.6',
            },
            version,
          })
        );
        await window.electronAPI.storage.setItem(
          'assistant-memory-preferences.v1',
          JSON.stringify({ state: memory, version: 2 })
        );
      },
      {
        memory: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            enabled: false,
            retrievalMode: 'off',
          },
        },
        version: ASSISTANT_PREFERENCES_STORE_VERSION,
      }
    );
    await page.reload();
    await ensureAssistantShellVisible(page);
    // Only the normal grant/mount flow authorizes the workspace for tools.
    await page.getByRole('button', { exact: true, name: 'Add Folder to Workspace' }).click();
    await expect
      .poll(async () => {
        const roots = await page.evaluate(
          async (workspace) =>
            await window.electronAPI?.db.query(
              'SELECT id FROM roots WHERE path = $1 AND status = $2',
              [workspace, 'live']
            ),
          workspace
        );
        const parsed = z.object({ rows: z.array(z.object({ id: z.string() })) }).parse(roots);
        workspaceRootId = parsed.rows[0]?.id;
        return workspaceRootId !== undefined;
      })
      .toBe(true);
    const record = decodeHostRecord(JSON.parse(await readFile(join(profile, 'host.json'), 'utf8')));
    expect(record.protocolVersion).toBe(AGENT_HOST_PROTOCOL_VERSION);
    expect(record.pid).not.toBe(process.pid);
    const start = processStartTime(record.pid);
    if (start) {
      owners.push({ pid: record.pid, start });
    }
    // Observe the host created by the app; never pre-start a replacement host.
    client = await attachAgentHost(record);
    const mountedRootId = workspaceRootId;
    if (!mountedRootId) {
      throw new Error('The ordinary workspace has no mounted root identity');
    }
    const home = new HomePage(page);
    await home.openSettings();
    await page.getByRole('button', { name: 'Search & Indexing' }).click();
    await page.getByTestId('settings-category-search-indexing').waitFor();
    await page.getByRole('combobox', { exact: true, name: 'Embedding model' }).click();
    await page.getByRole('option', { name: /BGE Small/ }).click();
    await page.getByRole('button', { exact: true, name: 'Use embedding model' }).click();
    await expect
      .poll(
        async () => await page.getByRole('combobox', { name: 'Managed collection' }).textContent()
      )
      .toContain('Workspace Index (BGE Small)');
    await page.getByRole('combobox', { name: 'Search mode' }).click();
    await page.getByRole('option', { exact: true, name: 'Text and semantic search' }).click();
    await page.getByRole('combobox', { name: 'Local model execution' }).click();
    await page.getByRole('option', { exact: true, name: 'WASM · Q8' }).click();
    // Observe actual canonical publication; never seed/query native rows here.
    await expect
      .poll(
        async () => {
          const publication = await page.evaluate(async (rootId) => {
            const capability = (
              globalThis as typeof globalThis & {
                readonly indexSearch?: IndexSearchCapability;
              }
            ).indexSearch;
            if (!capability) {
              throw new Error('The ordinary desktop has no native index capability');
            }
            const status = await capability.status();
            if (status.kind !== 'ready' || status.embedding.indexMode !== 'vector-configured') {
              return { ready: false, status };
            }
            const observation = await capability.coverageBatch([{ rootIds: [rootId] }]);
            if (observation.kind === 'blocked') {
              throw new Error(observation.reason);
            }
            if (observation.kind === 'invalidated') {
              return { observation, ready: false, status };
            }
            const snapshot = observation.status;
            const coverage = observation.coverage[0];
            const embeddingHost = window.embeddingHost;
            if (!(embeddingHost && 'getStatus' in embeddingHost)) {
              throw new Error('The visible renderer has no embedding status capability');
            }
            const hiddenStatus = await embeddingHost.getStatus();
            return {
              coverage,
              hiddenStatus,
              ready:
                snapshot.rootReadiness.some(
                  (root) => root.rootId === rootId && root.scanComplete
                ) &&
                coverage?.totals.indexedFiles === 2 &&
                coverage.totals.chunks >= 2 &&
                coverage.totals.vectors === coverage.totals.chunks &&
                coverage.vectorCoverageComplete,
              status: snapshot,
            };
          }, mountedRootId);
          await writeFile(
            join(evidence, 'native-publication.json'),
            JSON.stringify(publication, null, 2)
          );
          if ('hiddenStatus' in publication && publication.hiddenStatus?.state === 'error') {
            throw new Error(
              `Actual hidden embedding host failed: ${publication.hiddenStatus.lastError}`
            );
          }
          return publication.ready;
        },
        { timeout: getAdjustedTimeout('e2e') }
      )
      .toBe(true);
    await capture(application);
    const afterSetup = decodeHostRecord(
      JSON.parse(await readFile(join(profile, 'host.json'), 'utf8'))
    );
    expect({ pid: afterSetup.pid, start: afterSetup.start }).toEqual({
      pid: record.pid,
      start: record.start,
    });
    await home.leaveSettings();
    await ensureAssistantShellVisible(page);
    checkpoint('ordinary-native-vector-publication-ready');
    await page.getByTestId('assistant-new-thread-button').click();
    let discoveredThreadId: string | undefined;
    await expect
      .poll(async () => {
        const catalog = await client?.request('thread/list', {});
        const candidate = catalog?.threads.at(-1)?.threadId;
        if (
          candidate &&
          (await page.getByTestId(`assistant-thread-panel-${candidate}`).isVisible())
        ) {
          discoveredThreadId = candidate;
          return true;
        }
        return false;
      })
      .toBe(true);
    const threadId = discoveredThreadId;
    if (!threadId) {
      throw new Error('Ordinary New Thread or mounted workspace has no committed identity');
    }
    activeThreadId = threadId;
    checkpoint('ordinary-vector-new-thread-rendered');
    const input = page
      .getByTestId(`assistant-thread-panel-${threadId}`)
      .getByRole('textbox', { name: 'Message input' });
    await input.fill(
      'Use queryEmbeddingSpace and hybridSearch to find the SQLite reader isolation explanation.'
    );
    await input.press('Enter');
    await expect
      .poll(
        async () =>
          (await client?.request('thread/read', { fromSeq: 0, threadId }))?.rows.some(
            ({ event }) => event.type === 'run.finished'
          ),
        { timeout: getAdjustedTimeout('e2e') }
      )
      .toBe(true);
    const rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    // Retain committed execution and actual provider tool messages, excluding
    // the transient host authorization token, before any result assertion.
    await writeFile(
      join(evidence, 'vector-search-verdict.json'),
      JSON.stringify(
        {
          blockedExternalRequests,
          host: { pid: record.pid, protocolVersion: record.protocolVersion, start: record.start },
          providerRequests,
          rows,
          runtime,
          runtimeAssetRequests,
          threadId,
          workspaceRootId: mountedRootId,
        },
        null,
        2
      )
    );
    const calls = rows.flatMap(({ event }) =>
      event.type === 'effect.started' &&
      ['brainstrike_queryEmbeddingSpace', 'brainstrike_hybridSearch'].includes(event.toolId)
        ? [event]
        : []
    );
    expect(calls.map((call) => call.toolId)).toEqual([
      'brainstrike_queryEmbeddingSpace',
      'brainstrike_hybridSearch',
    ]);
    const results = calls.map((call) => {
      const finished = rows.find(
        ({ event }) => event.type === 'effect.finished' && event.toolCallId === call.toolCallId
      )?.event;
      if (finished?.type !== 'effect.finished') {
        throw new Error(`The ordinary Root did not commit its ${call.toolId} result`);
      }
      return finished.output;
    });
    const semantic = z
      .object({
        chunks: z.array(
          z.object({
            fileName: z.string(),
            filePath: z.string(),
            lineRange: z.object({ end: z.number().int(), start: z.number().int() }),
            metadata: z.object({ embeddingSetId: z.string(), rootId: z.literal(mountedRootId) }),
            rank: z.number().int(),
            score: z.number().finite(),
          })
        ),
        context: z.string(),
        embeddingSetId: z.string(),
        threshold: z.literal(0.3),
        truncated: z.literal(false),
      })
      .parse(results[0]);
    expect(
      semantic.chunks.map(({ fileName, filePath, lineRange, metadata, rank }) => ({
        fileName,
        filePath,
        lineRange,
        metadata,
        rank,
      }))
    ).toEqual([
      {
        fileName: 'vector-proof.md',
        filePath: 'vector-proof.md',
        lineRange: { end: 2, start: 1 },
        metadata: { embeddingSetId: semantic.embeddingSetId, rootId: mountedRootId },
        rank: 1,
      },
      {
        fileName: 'unrelated-proof.md',
        filePath: 'unrelated-proof.md',
        lineRange: { end: 2, start: 1 },
        metadata: { embeddingSetId: semantic.embeddingSetId, rootId: mountedRootId },
        rank: 2,
      },
    ]);
    expect(semantic.chunks[0]?.score).toBeGreaterThan(
      semantic.chunks[1]?.score ?? Number.POSITIVE_INFINITY
    );
    expect(semantic.context).toContain(searchLine);
    expect(semantic.context).toContain('vector-proof.md');
    const hybrid = z
      .object({
        embeddingSetId: z.literal(semantic.embeddingSetId),
        ftsWeight: z.literal(1),
        metadata: z.object({
          ftsResultCount: z.number().positive(),
          fusedResultCount: z.number().positive(),
          vectorResultCount: z.number().positive(),
        }),
        results: z.array(
          z.object({
            content: z.string(),
            fileName: z.string(),
            filePath: z.string(),
            ftsRank: z.number().finite(),
            position: z.number().int(),
            rrfScore: z.number().positive(),
            sourceCount: z.number().int(),
            vectorSimilarity: z.number().finite(),
          })
        ),
        truncated: z.literal(false),
        vectorWeight: z.literal(1),
      })
      .parse(results[1]);
    const selected = hybrid.results.find((result) => result.fileName === 'vector-proof.md');
    expect(selected?.content).toContain(searchLine);
    expect(selected?.sourceCount).toBe(3);
    expect(
      hybrid.results.map(({ fileName, filePath, position }) => ({ fileName, filePath, position }))
    ).toEqual([
      { fileName: 'vector-proof.md', filePath: 'vector-proof.md', position: 1 },
      { fileName: 'unrelated-proof.md', filePath: 'unrelated-proof.md', position: 2 },
    ]);
    expect(hybrid.results[0]?.rrfScore).toBeGreaterThan(
      hybrid.results[1]?.rrfScore ?? Number.POSITIVE_INFINITY
    );
    expect(hybrid.results[0]?.vectorSimilarity).toBeGreaterThan(
      hybrid.results[1]?.vectorSimilarity ?? Number.POSITIVE_INFINITY
    );
    expect(blockedExternalRequests).toEqual([]);
    expect(runtimeAssetRequests.some(({ url }) => url.endsWith('.wasm'))).toBe(true);
    expect(runtimeAssetRequests.some(({ url }) => url.endsWith('.mjs'))).toBe(true);
    const hiddenStatus = await page.evaluate(async () => {
      const embeddingHost = window.embeddingHost;
      if (!(embeddingHost && 'getStatus' in embeddingHost)) {
        throw new Error('The visible renderer has no embedding status capability');
      }
      return await embeddingHost.getStatus();
    });
    const windows = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        pid: window.webContents.getOSProcessId(),
        url: window.webContents.getURL(),
        visible: window.isVisible(),
      }))
    );
    await writeFile(
      join(evidence, 'hidden-runtime.json'),
      JSON.stringify({ hiddenStatus, windows }, null, 2)
    );
    expect(hiddenStatus.embeddingRuntime?.actualWorkerMetadata).toEqual({
      device: 'wasm',
      dtype: 'q8',
      fallbackApplied: false,
    });
    expect(
      windows.some((window) => window.url.includes('mode=embedding-host') && !window.visible)
    ).toBe(true);
    const toolMessage = z.object({
      content: z.string(),
      name: z.enum(['brainstrike_queryEmbeddingSpace', 'brainstrike_hybridSearch']),
      role: z.literal('tool'),
      tool_call_id: z.string(),
    });
    const followingRequests = providerRequests.slice(1).map(({ messages }) =>
      messages.flatMap((message) => {
        const parsed = toolMessage.safeParse(message);
        return parsed.success ? [parsed.data] : [];
      })
    );
    expect(followingRequests.map((messages) => messages.map(({ name }) => name))).toEqual([
      ['brainstrike_queryEmbeddingSpace'],
      ['brainstrike_queryEmbeddingSpace', 'brainstrike_hybridSearch'],
    ]);
    for (const message of followingRequests.flat()) {
      expect(message.content).toContain(searchLine);
      expect(message.content).toContain('unrelated-proof.md');
      expect(message.content.indexOf('vector-proof.md')).toBeGreaterThanOrEqual(0);
      expect(message.content.indexOf('vector-proof.md')).toBeLessThan(
        message.content.indexOf('unrelated-proof.md')
      );
      expect(calls.find(({ toolId }) => toolId === message.name)?.toolCallId).toBe(
        message.tool_call_id
      );
    }
    expect(
      rows.some(({ event }) => event.type === 'run.finished' && event.outcome === 'completed')
    ).toBe(true);
    checkpoint('ordinary-native-semantic-hybrid-result-completed');
  } catch (cause) {
    failure ??= cause;
    await writeFile(
      join(evidence, 'first-failure.json'),
      JSON.stringify(
        { message: String(failure), stack: failure instanceof Error ? failure.stack : undefined },
        null,
        2
      )
    );
    await writeFile(
      join(evidence, 'failure-provider-requests.json'),
      JSON.stringify(providerRequests, null, 2)
    );
    if (client && activeThreadId) {
      const snapshot = await Promise.allSettled([
        client
          .request('thread/read', { fromSeq: 0, threadId: activeThreadId })
          .then((value) =>
            writeFile(join(evidence, 'failure-thread.json'), JSON.stringify(value, null, 2))
          ),
      ]);
      await writeFile(
        join(evidence, 'capture-failures.json'),
        JSON.stringify(snapshot.filter((value) => value.status === 'rejected').map(String))
      );
    }
  } finally {
    await closeOnce();
  }
  async function closeResources(): Promise<void> {
    let providerClosed = false;
    if (application && observedPage) {
      try {
        const hiddenStatus = await observedPage.evaluate(async () => {
          const embeddingHost = window.embeddingHost;
          if (!(embeddingHost && 'getStatus' in embeddingHost)) {
            throw new Error('The visible renderer has no embedding status capability');
          }
          return await embeddingHost.getStatus();
        });
        const windows = await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            id: window.id,
            pid: window.webContents.getOSProcessId(),
            url: window.webContents.getURL(),
            visible: window.isVisible(),
          }))
        );
        await writeFile(
          join(evidence, 'hidden-runtime-at-cleanup.json'),
          JSON.stringify({ hiddenStatus, windows }, null, 2)
        );
      } catch (cause) {
        await writeFile(
          join(evidence, 'cleanup-diagnostic-failure.json'),
          JSON.stringify({ message: String(cause) })
        );
      }
    }
    try {
      await client?.close();
      await client?.closed;
    } catch (cause) {
      errors.push(cause);
    }
    try {
      if (application) {
        await capture(application);
      }
    } catch (cause) {
      errors.push(cause);
    }
    try {
      await application?.close();
    } catch (cause) {
      errors.push(cause);
    }
    try {
      await model.close();
      providerClosed = await providerPortRefused(model.baseUrl);
      if (!providerClosed) {
        errors.push(new Error('Acquired model provider listener remains open'));
      }
    } catch (cause) {
      errors.push(cause);
    }
    const remaining = owners.filter(({ pid, start }) => processStartTime(pid) === start);
    const root = RootLock.inspect(profile);
    const rootReleased = root?.owner.released ?? null;
    if (remaining.length > 0) {
      errors.push(new Error('Owned app or Root process remains live'));
    }
    if (application && rootReleased !== true) {
      errors.push(new Error('Ordinary app-owned Root did not release its lock'));
    }
    const originalModelDataUnchanged = await Promise.all(
      modelAssets.map(async (asset) => ({
        unchanged: (await fileSha256(asset.source)) === asset.sha256,
        url: asset.url,
      }))
    );
    await writeFile(
      join(evidence, 'original-model-data.json'),
      JSON.stringify(originalModelDataUnchanged, null, 2)
    );
    if (originalModelDataUnchanged.some(({ unchanged }) => !unchanged)) {
      errors.push(new Error('Original cached model data changed during this run'));
    }
    await writeFile(join(evidence, 'output.log'), outputs.join(''));
    await writeFile(
      join(evidence, 'blocked-external-requests.json'),
      JSON.stringify(blockedExternalRequests, null, 2)
    );
    await writeFile(
      join(evidence, 'runtime-asset-requests.json'),
      JSON.stringify(runtimeAssetRequests, null, 2)
    );
    await writeFile(
      join(evidence, 'cleanup.json'),
      JSON.stringify(
        {
          appLaunched: application !== undefined,
          errors: errors.map(String),
          failure: failure ? String(failure) : null,
          owners,
          providerBaseUrl: model.baseUrl,
          providerClosed,
          remaining,
          rootAbsent: root === null,
          rootReleased,
        },
        null,
        2
      )
    );
    process.stderr.write(`App-owned vector search evidence: ${evidence}\n`);
    if (!failure && errors.length === 0) {
      await rm(disposable, { recursive: true });
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      'Ordinary app-owned vector search and cleanup failed'
    );
  }
  if (failure) {
    throw failure;
  }
}

interface CachedModelAsset {
  readonly destination: string;
  readonly sha256: string;
  readonly source: string;
  readonly url: string;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** Copy only installed public model data and its cache index into this fresh profile. */
async function copyExistingModelCache(disposable: string): Promise<CachedModelAsset[]> {
  const source = process.env['BRAINSTRIKE_M3_TRANSFORMERS_CACHE_ORIGIN'];
  if (!source) {
    throw new Error(
      'BRAINSTRIKE_M3_TRANSFORMERS_CACHE_ORIGIN must identify an existing file:/// transformers-cache; no model downloads are permitted.'
    );
  }
  const index = await readFile(join(source, 'index.txt'));
  if (!(index.includes('file:///') && index.includes('transformers-cache'))) {
    throw new Error('Installed model cache has the wrong origin or cache name');
  }
  const origin = source.split('/').at(-1);
  if (!(origin && /^[a-f0-9]{40}$/u.test(origin))) {
    throw new Error('Installed model cache has no canonical storage origin');
  }
  const destination = join(disposable, 'session-data/Service Worker/CacheStorage', origin);
  const expected = new Set([
    'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/config.json',
    'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/tokenizer_config.json',
    'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/tokenizer.json',
    'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx',
  ]);
  const assets: CachedModelAsset[] = [];
  await mkdir(destination, { recursive: true });
  await copyFile(join(source, 'index.txt'), join(destination, 'index.txt'));
  for (const cache of await readdir(source, { withFileTypes: true })) {
    if (!cache.isDirectory()) {
      continue;
    }
    const selected: CachedModelAsset[] = [];
    for (const entry of await readdir(join(source, cache.name), { withFileTypes: true })) {
      if (!(entry.isFile() && /^[a-f0-9]{16}_0$/u.test(entry.name))) {
        continue;
      }
      const from = join(source, cache.name, entry.name);
      const file = await open(from, 'r');
      let header: Buffer;
      try {
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        header = buffer.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
      const url = header
        .toString('latin1')
        .match(/https:\/\/huggingface\.co\/[A-Za-z0-9_./?=&%+-]+/u)?.[0];
      if (!(url && expected.has(url))) {
        continue;
      }
      const to = join(destination, cache.name, entry.name);
      await mkdir(join(destination, cache.name), { recursive: true });
      const sha256 = await fileSha256(from);
      await copyFile(from, to);
      if ((await fileSha256(to)) !== sha256) {
        throw new Error(`Installed model cache copy changed ${url}`);
      }
      selected.push({ destination: to, sha256, source: from, url });
    }
    if (selected.length > 0) {
      await mkdir(join(destination, cache.name, 'index-dir'), { recursive: true });
      await copyFile(join(source, cache.name, 'index'), join(destination, cache.name, 'index'));
      await copyFile(
        join(source, cache.name, 'index-dir/the-real-index'),
        join(destination, cache.name, 'index-dir/the-real-index')
      );
      assets.push(...selected);
    }
  }
  if (
    assets.length !== expected.size ||
    new Set(assets.map((asset) => asset.url)).size !== expected.size
  ) {
    throw new Error(
      `Installed BGE Small assets are incomplete: ${JSON.stringify(assets.map((asset) => asset.url))}`
    );
  }
  return assets;
}

interface InstalledRuntimeAsset {
  readonly contentType: string;
  readonly path: string;
  readonly sha256: string;
  readonly url: string;
}

/** Deliver installed vendor bytes requested by the production worker without CDN egress. */
async function existingOrtAssets(): Promise<ReadonlyMap<string, InstalledRuntimeAsset>> {
  const requireSdk = createRequire(
    resolve(
      desktop,
      '../../packages/embedding-worker/node_modules/@huggingface/transformers/package.json'
    )
  );
  const packageRoot = resolve(dirname(requireSdk.resolve('onnxruntime-web')), '..');
  const { version } = z
    .object({ name: z.literal('onnxruntime-web'), version: z.string().min(1) })
    .parse(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')));
  const assets = new Map<string, InstalledRuntimeAsset>();
  for (const file of [
    'ort-wasm-simd-threaded.asyncify.mjs',
    'ort-wasm-simd-threaded.asyncify.wasm',
  ]) {
    const path = join(packageRoot, 'dist', file);
    const sha256 = await fileSha256(path);
    const url = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/${file}`;
    assets.set(url, {
      contentType: file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
      path,
      sha256,
      url,
    });
  }
  return assets;
}
