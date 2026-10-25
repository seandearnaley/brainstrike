// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { AGENT_HOST_PROTOCOL_VERSION } from '@brainstrike/agent-host';
import type { HostClient } from '@brainstrike/agent-host/client';
import { ASSISTANT_PREFERENCES_STORE_VERSION } from '@brainstrike/app-state/stores/assistant-preferences-store-version';
import {
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  parseOpenRouterModelMetadata,
} from '@brainstrike/assistant-contract';
import { parseGrepToolResult } from '@brainstrike/host-capabilities/grep-search-result-contract';
import { joinProcessExit, processStartTime } from '@brainstrike/test-utils/process-identity';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { _electron, type ElectronApplication } from 'playwright';
import { expect, onTestFinished } from 'vitest';
import { z } from 'zod';
import { attachHostThroughWindow } from '../../../e2e/utils/agent-host-log';
import { closeElectronApp } from '../../../e2e/utils/electron-helpers.mts';
import { ensureAssistantShellVisible } from '../../../e2e/utils/layout-helpers';
import {
  type ModelProviderRequest,
  startModelProviderShim,
} from '../../../e2e/utils/model-provider-shim';
import { addWorkspaceFolder } from './add-workspace-folder';
import { createAppOutput } from './app-output';
import { createDisposableAppProfile } from './disposable-app-profile';
import { electronExecutablePath, FOREGROUND_RENDERER_SWITCHES } from './electron-executable';
import { launchAppWithLauncher } from './electron-launcher-watchdog';
import { writeFirstFailure } from './failure-evidence';
import { type OwnedTestProcess, retireOwnedTestProcesses } from './retire-owned-test-processes';
import { isRootHeld } from './root-held';

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
// A graceful step that outlives these bounds is a leak and fails the proof.
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
  let client: HostClient | undefined;
  let failure: unknown;
  const errors: unknown[] = [];
  const owners: OwnedTestProcess[] = [];
  const output = createAppOutput(join(evidence, 'output.log'));
  const capture = async (app: ElectronApplication): Promise<void> => {
    for (const { pid } of await app.evaluate(({ app }) => app.getAppMetrics())) {
      const start = processStartTime(pid);
      if (start && !owners.some((owner) => owner.pid === pid && owner.start === start)) {
        owners.push({ kind: 'child', pid, start });
      }
    }
  };
  const checkpoint = (phase: string): void => {
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), phase })}\n`);
  };
  const model = await startModelProviderShim((request) => {
    providerRequests.push(request);
    // The ordinary default catalog installs hosted tool discovery.
    if (!request.toolNames.includes('load_tool')) {
      throw new Error('The ordinary default catalog did not install hosted tool discovery');
    }
    if (!workspaceRootId) {
      throw new Error('The ordinary workspace has no authoritative root identity');
    }
    return {
      finalText: 'The selected indexed and live text was received.',
      toolCall: {
        arguments: {
          filePaths: ['indexed-proof.md'],
          isRegex: false,
          maxResults: 5,
          outputMode: 'content',
          pattern: 'INDEXEDTEXTSENTINEL4802',
          root: workspaceRootId,
        },
        name: 'brainstrike_grepSearch',
      },
    };
  });
  let providerClosed = false;
  let remaining: {
    pid: number;
    start: string;
  }[] = [];
  let released: Promise<void> | undefined;
  /**
   * Closes everything this proof started, once. It runs when the proof returns
   * or fails, and from Vitest's onTestFinished when the test times out, so the
   * proof retains any failure. App retirement uses SIGTERM only; a surviving
   * process keeps its disposable profile for diagnosis.
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
        if (application) {
          await closeElectronApp({ app: application });
        }
      } catch (cause) {
        errors.push(cause);
      }
      try {
        await retireOwnedTestProcesses(owners, {
          join: ({ pid, start }) => joinProcessExit(pid, start),
          signal: (pid, signal) => process.kill(pid, signal),
          startTime: processStartTime,
        });
      } catch (cause) {
        errors.push(cause);
      }
      remaining = owners.filter(({ pid, start }) => processStartTime(pid) === start);
      try {
        if (application) {
          await within(output.expectCleanShutdown(), 'The app output close');
        }
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
    expect(isRootHeld(profile)).toBe(false);
    checkpoint('ordinary-search-launch-start');
    application = await launchAppWithLauncher(() =>
      _electron.launch({
        args: [
          join(desktop, 'dist/main.js'),
          '--test-mode',
          `--user-data-dir=${disposable}`,
          '--brainstrike-desktop-launch-mode=test-built',
          ...FOREGROUND_RENDERER_SWITCHES,
        ],
        env,
        executablePath: electronExecutablePath(),
      })
    );
    const appProcess = application.process();
    const appStart = appProcess.pid && processStartTime(appProcess.pid);
    if (appProcess.pid && appStart) {
      owners.push({ kind: 'app', pid: appProcess.pid, start: appStart });
    }
    output.record(appProcess);
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
    workspaceRootId = await addWorkspaceFolder(page, workspace);
    // Observe the host created by the app, through its own window's connect.
    client = await attachHostThroughWindow(page);
    expect(client.host.protocolVersion).toBe(AGENT_HOST_PROTOCOL_VERSION);
    expect(client.host.pid).not.toBe(process.pid);
    const record = { ...client.host, start: processStartTime(client.host.pid) };
    if (record.start) {
      owners.push({ kind: 'child', pid: record.pid, start: record.start });
    }
    const mountedRootId = workspaceRootId;
    if (!mountedRootId) {
      throw new Error('The ordinary workspace has no mounted root identity');
    }
    // A fresh profile indexes Text search; observe actual canonical publication and never
    // seed/query native rows here.
    await expect
      .poll(
        async () => {
          const publication = await page.evaluate(async (rootId) => {
            const capability = window.indexSearch;
            if (!capability) {
              throw new Error('The ordinary desktop has no native index capability');
            }
            const statusResult = await capability.status();
            if (!statusResult.ok) {
              throw new Error(statusResult.error.message);
            }
            const status = statusResult.value;
            if (status.kind !== 'ready' || status.embedding.indexMode !== 'text-only') {
              return { ready: false, status };
            }
            const coverageResult = await capability.coverageBatch([{ rootIds: [rootId] }]);
            if (!coverageResult.ok) {
              throw new Error(coverageResult.error.message);
            }
            const observation = coverageResult.value;
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
    // Indexing setup ran in the one host the app started.
    expect(processStartTime(record.pid)).toBe(record.start);
    await ensureAssistantShellVisible(page);
    checkpoint('ordinary-native-text-publication-ready');
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
    if (!threadId) {
      throw new Error('Ordinary New Thread or mounted workspace has no committed identity');
    }
    activeThreadId = threadId;
    checkpoint('ordinary-indexed-text-new-thread-rendered');
    const input = page
      .getByTestId(`assistant-thread-panel-${threadId}`)
      .getByRole('textbox', { name: 'Message input' });
    await input.fill('Find INDEXEDTEXTSENTINEL4802 literally in indexed-proof.md.');
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
    {
      const calls = rows.flatMap(({ event }) =>
        event.type === 'effect.started' && event.toolId === 'brainstrike_grepSearch' ? [event] : []
      );
      expect(calls).toHaveLength(1);
      const finished = rows.find(
        ({ event }) => event.type === 'effect.finished' && event.toolCallId === calls[0]?.toolCallId
      )?.event;
      if (finished?.type !== 'effect.finished') {
        throw new Error('The ordinary Root did not commit its grep result');
      }
      const result = parseGrepToolResult(finished.output);
      expect(result.outputMode).toBe('content');
      if (result.outputMode !== 'content') {
        throw new Error('The grep returned the wrong output mode');
      }
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject({
        line: 2,
        lineText: searchLine,
        path: 'indexed-proof.md',
        rootId: mountedRootId,
      });
      expect(result.truncated).toBe(false);
      expect(
        rows.some(({ event }) => event.type === 'run.finished' && event.outcome === 'completed')
      ).toBe(true);
      expect(
        providerRequests
          .flatMap(({ messages }) => messages)
          .some(
            (message) =>
              z.object({ role: z.literal('tool') }).safeParse(message).success &&
              JSON.stringify(message).includes(searchLine)
          )
      ).toBe(true);
      checkpoint('ordinary-indexed-and-live-grep-completed');
    }
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
      // Quit is the one stop: Main asks its host to close, joins it and the
      // native owners, and only then exits.
      await client.close();
      await client.closed;
      client = undefined;
      await capture(application);
      await closeElectronApp({ app: application });
      application = undefined;
      await within(output.expectCleanShutdown(), 'The app output close');
      const stillLive = [...nativeOwners, { name: 'agent-host', ...record }].filter(
        ({ pid, start }) => start && processStartTime(pid) === start
      );
      const rootReleased = !isRootHeld(profile);
      await writeFile(
        join(evidence, 'host-stop-verdict.json'),
        JSON.stringify(
          {
            beforeStop,
            nativeOwners,
            rootReleased,
            stillLive,
          },
          null,
          2
        )
      );
      expect(rootReleased).toBe(true);
      expect(stillLive).toEqual([]);
    }
  } catch (cause) {
    failure = cause;
    await writeFirstFailure(evidence, cause);
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
    const rootReleased = !isRootHeld(profile);
    if (application && rootReleased !== true) {
      errors.push(new Error('Ordinary app-owned Root did not release its lock'));
    }
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
