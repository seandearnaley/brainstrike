// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
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
import { _electron, type ElectronApplication } from 'playwright';
import { expect, onTestFinished } from 'vitest';
import { z } from 'zod';
import { HomePage } from '../../../e2e/page-objects/home-page';
import { ensureAssistantShellVisible } from '../../../e2e/utils/layout-helpers';
import {
  type ModelProviderRequest,
  startModelProviderShim,
} from '../../../e2e/utils/model-provider-shim';
import { createDisposableAppProfile } from './disposable-app-profile';
import { killAppWithLauncher } from './electron-launcher-watchdog';

const desktop = resolve(import.meta.dirname, '../../..');
// Reuse the recorded public metadata fixture; no provider grant or inference.
const recordedModelMetadata = parseOpenRouterModelMetadata(
  JSON.parse(
    await readFile(
      new URL('../fixtures/openrouter-sonnet-4-6-model-metadata.json', import.meta.url),
      'utf8'
    )
  ),
  'anthropic/claude-sonnet-4.6',
  Date.parse('2026-10-07T05:07:09.516Z')
);

// A graceful step that outlives these bounds is a leak: it is recorded, then killed.
const CLOSE_STEP_MS = 30_000;
const RELEASE_HOOK_MS = 120_000;

async function within<T>(step: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      step,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not finish within ${CLOSE_STEP_MS} ms`)),
          CLOSE_STEP_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

export async function qualifyOrdinaryAppIndexedText(
  options: { readonly stopHost?: boolean } = {}
): Promise<void> {
  const { evidence, root: disposable } = await createDisposableAppProfile(
    options.stopHost ? 'brainstrike-m3-app-owned-stop-' : 'brainstrike-m3-app-owned-indexed-text-'
  );
  const profile = join(disposable, 'profiles/m3-indexed-text');
  const workspace = join(disposable, 'workspace');
  await mkdir(profile, { recursive: true });
  await mkdir(workspace);
  const searchLine = 'INDEXEDTEXTSENTINEL4802 belongs to the selected real indexed file.';
  await writeFile(join(workspace, 'indexed-proof.md'), `# Indexed text proof\n${searchLine}\n`);
  await writeFile(
    join(workspace, 'unselected-proof.md'),
    '# Unselected text proof\nINDEXEDTEXTSENTINEL4802 belongs to the unselected real indexed file.\n'
  );
  const providerRequests: ModelProviderRequest[] = [];
  let workspaceRootId: string | undefined;
  let activeThreadId: string | undefined;
  let application: ElectronApplication | undefined;
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
  };
  const checkpoint = (phase: string): void => {
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), phase })}\n`);
  };
  const model = await startModelProviderShim((request) => {
    providerRequests.push(request);
    // Hosted discovery defers querySelf: the model loads it first.
    if (!request.toolNames.includes('load_tool')) {
      throw new Error('The ordinary default catalog did not install hosted tool discovery');
    }
    if (!workspaceRootId) {
      throw new Error('The ordinary workspace has no authoritative root identity');
    }
    return {
      finalText: 'The selected indexed SQLite text result was received.',
      toolCallStages: [
        [{ arguments: { toolName: 'brainstrike_querySelf' }, name: 'load_tool' }],
        [{ arguments: { mode: 'listTables', target: 'index' }, name: 'brainstrike_querySelf' }],
        [
          {
            arguments: { mode: 'describeTable', table: 'file_records', target: 'index' },
            name: 'brainstrike_querySelf',
          },
        ],
        [
          {
            arguments: { mode: 'describeTable', table: 'file_chunks', target: 'index' },
            name: 'brainstrike_querySelf',
          },
        ],
        [
          {
            arguments: {
              maxRows: 5,
              mode: 'query',
              sql: "SELECT f.name AS file_name, f.path AS file_path, c.content AS content, c.start_line AS start_line, c.end_line AS end_line FROM file_chunks_fts JOIN file_chunks AS c ON c.pk = file_chunks_fts.rowid JOIN file_records AS f ON f.id = c.file_record_id WHERE file_chunks_fts MATCH 'INDEXEDTEXTSENTINEL4802' AND f.name = 'indexed-proof.md' ORDER BY c.start_line LIMIT 5",
              target: 'index',
            },
            name: 'brainstrike_querySelf',
          },
        ],
      ],
    };
  });
  let providerClosed = false;
  let remaining: { pid: number; start: string }[] = [];
  let released: Promise<void> | undefined;
  /**
   * Closes everything this proof started, once. It runs when the proof returns
   * or fails, and from Vitest's onTestFinished when the test times out, so the
   * app never outlives the test. An owned process that survives the graceful
   * close fails the proof and is then killed.
   */
  const release = (): Promise<void> => {
    released ??= (async () => {
      try {
        await within(
          (async () => {
            await client?.close();
            await client?.closed;
          })(),
          'The host client close'
        );
      } catch (cause) {
        errors.push(cause);
      }
      try {
        if (application) {
          await within(capture(application), 'The owned process capture');
        }
      } catch (cause) {
        errors.push(cause);
      }
      try {
        await within(application?.close() ?? Promise.resolve(), 'The Electron app close');
      } catch (cause) {
        errors.push(cause);
      }
      remaining = owners.filter(({ pid, start }) => processStartTime(pid) === start);
      if (remaining.length > 0) {
        errors.push(new Error('Owned app or Root process remains live'));
        for (const { pid } of remaining) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (cause) {
            errors.push(cause);
          }
        }
        await expect
          .poll(() => owners.filter(({ pid, start }) => processStartTime(pid) === start))
          .toEqual([]);
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
    })();
    return released;
  };
  onTestFinished(release, RELEASE_HOOK_MS);
  try {
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
      BRAINSTRIKE_DB_PROFILE: 'm3-indexed-text',
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
    if (appProcess.pid) {
      killAppWithLauncher(appProcess.pid);
    }
    const appStart = appProcess.pid && processStartTime(appProcess.pid);
    if (appProcess.pid && appStart) {
      owners.push({ pid: appProcess.pid, start: appStart });
    }
    appProcess.stdout?.on('data', (data: Buffer) => outputs.push(data.toString()));
    appProcess.stderr?.on('data', (data: Buffer) => outputs.push(data.toString()));
    await capture(application);
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
    await page.getByRole('option', { exact: true, name: 'Text search' }).click();
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
            if (status.kind !== 'ready' || status.embedding.indexMode !== 'text-only') {
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
            return {
              coverage,
              ready:
                snapshot.rootReadiness.some(
                  (root) => root.rootId === rootId && root.scanComplete
                ) &&
                coverage?.totals.indexedFiles === 2 &&
                coverage.totals.chunks >= 2 &&
                coverage.totals.vectors === 0,
              status: snapshot,
            };
          }, mountedRootId);
          await writeFile(
            join(evidence, 'native-publication.json'),
            JSON.stringify(publication, null, 2)
          );
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
    checkpoint('ordinary-native-text-publication-ready');
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
    checkpoint('ordinary-indexed-text-new-thread-rendered');
    const input = page
      .getByTestId(`assistant-thread-panel-${threadId}`)
      .getByRole('textbox', { name: 'Message input' });
    await input.fill(
      'Use querySelf target index to find INDEXEDTEXTSENTINEL4802 in indexed-proof.md.'
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
      join(evidence, 'indexed-text-verdict.json'),
      JSON.stringify(
        {
          host: { pid: record.pid, protocolVersion: record.protocolVersion, start: record.start },
          providerRequests,
          rows,
          runtime,
          threadId,
          workspaceRootId: mountedRootId,
        },
        null,
        2
      )
    );
    const calls = rows.flatMap(({ event }) =>
      event.type === 'effect.started' && event.toolId === 'brainstrike_querySelf' ? [event] : []
    );
    expect(calls).toHaveLength(4);
    const results = calls.map((call) => {
      const finished = rows.find(
        ({ event }) => event.type === 'effect.finished' && event.toolCallId === call.toolCallId
      )?.event;
      if (finished?.type !== 'effect.finished') {
        throw new Error('The ordinary Root did not commit its querySelf index result');
      }
      return finished.output;
    });
    const tables = z
      .object({
        kind: z.literal('tables'),
        tables: z.array(z.object({ name: z.string() })),
        target: z.literal('index'),
      })
      .parse(results[0]);
    expect(tables.tables.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['file_records', 'file_chunks', 'file_chunks_fts'])
    );
    for (const description of results.slice(1, 3)) {
      z.object({ kind: z.literal('columns'), target: z.literal('index') }).parse(description);
    }
    const result = z
      .object({
        columns: z.array(z.string()),
        kind: z.literal('rows'),
        rowCount: z.literal(1),
        rows: z.array(z.object({ cells: z.array(z.string()) })),
        target: z.literal('index'),
        truncated: z.literal(false),
      })
      .parse(results[3]);
    expect(result.columns).toEqual(['file_name', 'file_path', 'content', 'start_line', 'end_line']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.cells[0]).toBe('indexed-proof.md');
    expect(result.rows[0]?.cells[2]).toContain(searchLine);
    const toolMessages = providerRequests.flatMap(({ messages }) =>
      messages.filter((message) => z.object({ role: z.literal('tool') }).safeParse(message).success)
    );
    expect(JSON.stringify(toolMessages)).toContain('indexed-proof.md');
    expect(JSON.stringify(toolMessages)).toContain(searchLine);
    expect(JSON.stringify(toolMessages)).not.toContain('unselected-proof.md');
    expect(
      rows.some(({ event }) => event.type === 'run.finished' && event.outcome === 'completed')
    ).toBe(true);
    checkpoint('ordinary-native-sqlite-index-query-result-completed');
    if (options.stopHost) {
      const beforeStop = await application.evaluate(({ app }) => app.getAppMetrics());
      const nativeOwners = beforeStop
        .filter(({ name }) =>
          ['brainstrike-indexer', 'brainstrike-index-query', 'brainstrike-index-coverage'].includes(
            name ?? ''
          )
        )
        .map(({ pid, name }) => ({ name, pid, start: processStartTime(pid) }));
      expect(nativeOwners.some(({ name }) => name === 'brainstrike-indexer')).toBe(true);
      const stopped = await client.request('host/stop', {});
      const stillLive = nativeOwners.filter(
        ({ pid, start }) => start && processStartTime(pid) === start
      );
      await writeFile(
        join(evidence, 'host-stop-verdict.json'),
        JSON.stringify(
          {
            beforeStop,
            nativeOwners,
            rootReleased: RootLock.inspect(profile)?.owner.released,
            stillLive,
            stopped,
          },
          null,
          2
        )
      );
      expect(stopped.rootReleased).toBe(true);
      expect(stillLive).toEqual([]);
    }
  } catch (cause) {
    failure = cause;
    await writeFile(
      join(evidence, 'first-failure.json'),
      JSON.stringify(
        { message: String(cause), stack: cause instanceof Error ? cause.stack : undefined },
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
    await release();
    const root = RootLock.inspect(profile);
    const rootReleased = root?.owner.released ?? null;
    if (application && rootReleased !== true) {
      errors.push(new Error('Ordinary app-owned Root did not release its lock'));
    }
    await writeFile(join(evidence, 'output.log'), outputs.join(''));
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
    process.stderr.write(`App-owned indexed text evidence: ${evidence}\n`);
  }
  if (errors.length > 0) {
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      'Ordinary app-owned search and cleanup failed'
    );
  }
  if (failure) {
    throw failure;
  }
}
