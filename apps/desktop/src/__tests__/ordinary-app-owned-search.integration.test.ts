// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { AGENT_HOST_PROTOCOL_VERSION, attachAgentHost } from '@brainstrike/agent-host';
import { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import { ASSISTANT_PREFERENCES_STORE_VERSION } from '@brainstrike/app-state/stores/assistant-preferences-store-version';
import {
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  parseOpenRouterModelMetadata,
} from '@brainstrike/assistant-contract';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { _electron, type ElectronApplication } from 'playwright';
import { expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import { ensureAssistantShellVisible } from '../../e2e/utils/layout-helpers';
import {
  type ModelProviderRequest,
  startModelProviderShim,
} from '../../e2e/utils/model-provider-shim';
import { createDisposableAppProfile } from './helpers/disposable-app-profile';

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

test('ordinary app-owned fresh Root returns scoped assistant grep results to the model', {
  timeout: getAdjustedTimeout('e2e'),
}, async () => {
  await qualifyOrdinarySearch('none');
});

test('post-provider MCP setup failure closes the acquired local model', {
  timeout: getAdjustedTimeout('e2e'),
}, async () => {
  await qualifyOrdinarySearch('mcp-setup-failure');
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

async function qualifyOrdinarySearch(fault: 'none' | 'mcp-setup-failure'): Promise<void> {
  const { evidence, root: disposable } = await createDisposableAppProfile(
    'brainstrike-m3-app-owned-search-'
  );
  const profile = join(disposable, 'profiles/m3-search');
  const workspace = join(disposable, 'workspace');
  await mkdir(profile, { recursive: true });
  await mkdir(workspace);
  const searchLine = 'FRESH_ROOT_SEARCH_SENTINEL_6724 is only in this selected file.';
  await writeFile(
    join(workspace, 'fresh-root-search.txt'),
    `Fresh Root search proof\n${searchLine}\n`
  );
  await writeFile(
    join(workspace, 'unselected-search.txt'),
    'FRESH_ROOT_SEARCH_SENTINEL_6724 must not appear in the selected-file result.\n'
  );
  const providerRequests: ModelProviderRequest[] = [];
  let workspaceRootId: string | undefined;
  let application: ElectronApplication | undefined;
  let client: Awaited<ReturnType<typeof attachAgentHost>> | undefined;
  let failure: unknown;
  const errors: unknown[] = [];
  const cleanupDone = Promise.withResolvers<void>();
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
    if (!request.toolNames.includes('brainstrike_grepSearch')) {
      throw new Error('The ordinary default catalog did not admit grepSearch');
    }
    if (!workspaceRootId) {
      throw new Error('The ordinary workspace has no authoritative root identity');
    }
    return {
      finalText: 'The scoped fresh Root search result was received.',
      toolCallStages: [
        [
          {
            arguments: {
              filePaths: ['fresh-root-search.txt'],
              outputMode: 'content',
              pattern: 'FRESH_ROOT_SEARCH_SENTINEL_6724',
              root: workspaceRootId,
            },
            name: 'brainstrike_grepSearch',
          },
        ],
      ],
    };
  });
  try {
    // A real mkdir collision exercises the setup failure after listener acquisition.
    if (fault === 'mcp-setup-failure') {
      await writeFile(join(disposable, 'mcp'), 'MCP directory collision fixture');
    }
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
      BRAINSTRIKE_DB_PROFILE: 'm3-search',
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
        if (!(window.modelCatalog && window.electronAPI && 'storage' in window.electronAPI)) {
          throw new Error('The normal desktop model catalog/storage bridge is missing');
        }
        await window.modelCatalog.setModels(['anthropic/claude-sonnet-4.6'], true);
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
        const roots = await page.evaluate(async (workspace) => {
          const api = window.electronAPI;
          if (!(api && 'fileSystem' in api)) {
            throw new Error('The normal desktop filesystem bridge is missing');
          }
          const reply = await api.fileSystem.restoreRoots();
          if (!reply.ok) {
            throw new Error(reply.error.message);
          }
          return reply.value.filter((root) => root.handle.path === workspace);
        }, workspace);
        const parsed = z.array(z.object({ rootId: z.string() })).parse(roots);
        workspaceRootId = parsed[0]?.rootId;
        return workspaceRootId !== undefined;
      })
      .toBe(true);
    // The startup thread is already open and visible; New Thread's own thread
    // is the one that was not there before the click.
    await page.getByRole('textbox', { name: 'Message input' }).waitFor();
    const threadsBeforeClick = new Set(
      await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="assistant-thread-panel-"]')].map((panel) =>
          panel.getAttribute('data-testid')?.slice('assistant-thread-panel-'.length)
        )
      )
    );
    await page.getByTestId('assistant-new-thread-button').click();
    const record = decodeHostRecord(JSON.parse(await readFile(join(profile, 'host.json'), 'utf8')));
    expect(record.protocolVersion).toBe(AGENT_HOST_PROTOCOL_VERSION);
    expect(record.pid).not.toBe(process.pid);
    const start = processStartTime(record.pid);
    if (start) {
      owners.push({ pid: record.pid, start });
    }
    // Observe the host created by the app; never pre-start a replacement host.
    client = await attachAgentHost(record);
    let discoveredThreadId: string | undefined;
    await expect
      .poll(async () => {
        const catalog = await client?.request('thread/list', {});
        const candidate = catalog?.threads.at(-1)?.threadId;
        if (
          candidate &&
          !threadsBeforeClick.has(candidate) &&
          (await page.getByTestId(`assistant-thread-panel-${candidate}`).isVisible())
        ) {
          discoveredThreadId = candidate;
          return true;
        }
        return false;
      })
      .toBe(true);
    const threadId = discoveredThreadId;
    const mountedRootId = workspaceRootId;
    if (!(threadId && mountedRootId)) {
      throw new Error('Ordinary New Thread or mounted workspace has no committed identity');
    }
    checkpoint('ordinary-search-new-thread-rendered');
    const input = page
      .getByTestId(`assistant-thread-panel-${threadId}`)
      .getByRole('textbox', { name: 'Message input' });
    await input.fill('Find FRESH_ROOT_SEARCH_SENTINEL_6724 in fresh-root-search.txt.');
    await input.press('Enter');
    const session = new CommittedThreadSession(client, threadId);
    const completion = Promise.withResolvers<void>();
    const release = session.subscribe(() => {
      const snapshot = session.getSnapshot();
      if (snapshot.error) {
        completion.reject(new Error(snapshot.error));
      } else if (!snapshot.connected) {
        completion.reject(new Error('Host disconnected before the committed run finished'));
      } else if (snapshot.rows.some(({ event }) => event.type === 'run.finished')) {
        completion.resolve();
      }
    });
    const disconnect = session.connect();
    onTestFinished(async () => {
      completion.reject(new Error('Test cleanup ended the pending host run wait'));
      await cleanupDone.promise;
    });
    try {
      await completion.promise;
      expect(session.getSnapshot().rows.some(({ event }) => event.type === 'run.finished')).toBe(
        true
      );
    } finally {
      release();
      await disconnect();
    }
    const rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    // Retain committed execution and actual provider tool messages, excluding
    // the transient host authorization token, before any result assertion.
    await writeFile(
      join(evidence, 'search-verdict.json'),
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
    const search = rows.find(
      ({ event }) => event.type === 'effect.started' && event.toolId === 'brainstrike_grepSearch'
    )?.event;
    if (search?.type !== 'effect.started') {
      throw new Error('The ordinary fresh Root did not execute the admitted grepSearch tool');
    }
    const finished = rows.find(
      ({ event }) => event.type === 'effect.finished' && event.toolCallId === search.toolCallId
    )?.event;
    if (finished?.type !== 'effect.finished') {
      throw new Error('The ordinary fresh Root grepSearch did not commit its result');
    }
    // This proves fresh on-disk literal grep. It makes no SQLite-indexed,
    // embedding, semantic or hybrid retrieval claim.
    const result = z
      .object({
        candidatesTruncated: z.literal(false),
        liveEngine: z.literal('js-files'),
        matches: z.array(
          z.object({
            line: z.literal(2),
            lineText: z.literal(searchLine),
            path: z.literal('fresh-root-search.txt'),
            rootId: z.literal(mountedRootId),
            source: z.literal('live'),
          })
        ),
        outputMode: z.literal('content'),
        scanLimited: z.literal(false),
        totalMatches: z.literal(1),
        truncated: z.literal(false),
      })
      .parse(finished.output);
    expect(result.matches).toHaveLength(1);
    const toolMessages = providerRequests.flatMap(({ messages }) =>
      messages.filter((message) => z.object({ role: z.literal('tool') }).safeParse(message).success)
    );
    expect(JSON.stringify(toolMessages)).toContain('fresh-root-search.txt');
    expect(JSON.stringify(toolMessages)).toContain(searchLine);
    expect(JSON.stringify(toolMessages)).not.toContain('unselected-search.txt');
    expect(
      rows.some(({ event }) => event.type === 'run.finished' && event.outcome === 'completed')
    ).toBe(true);
    checkpoint('ordinary-fresh-root-assistant-grep-result-completed');
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
  } finally {
    try {
      let providerClosed = false;
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
      await writeFile(join(evidence, 'output.log'), outputs.join(''));
      await writeFile(
        join(evidence, 'cleanup.json'),
        JSON.stringify(
          {
            appLaunched: application !== undefined,
            errors: errors.map(String),
            failure: failure ? String(failure) : null,
            fault,
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
      process.stderr.write(`App-owned search evidence: ${evidence}\n`);
    } finally {
      cleanupDone.resolve();
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      'Ordinary app-owned search and cleanup failed'
    );
  }
  if (fault === 'mcp-setup-failure') {
    expect(failure).toMatchObject({
      code: 'EEXIST',
      path: join(disposable, 'mcp'),
      syscall: 'mkdir',
    });
    expect(application).toBeUndefined();
    expect(providerRequests).toHaveLength(0);
    expect(RootLock.inspect(profile)).toBeNull();
    checkpoint('expected-mcp-setup-failure-provider-cleanup-completed');
    return;
  }
  if (failure) {
    throw failure;
  }
}
