import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { foldHostRuns } from '@brainstrike/agent-host/thread-view';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { type HostThreadLog, readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

const CANVAS_TITLE = 'Approved exploration canvas';
const CANVAS_HTML = '<!doctype html><html><body><h1>Approved exploration canvas</h1></body></html>';
const WORKERS = [
  { content: 'ALPHA_WORKER_OUTPUT\n', marker: 'FRESH_WORKER_ALPHA', path: 'alpha-output.txt' },
  { content: 'BETA_WORKER_OUTPUT\n', marker: 'FRESH_WORKER_BETA', path: 'beta-output.txt' },
] as const;

interface CheckpointRow {
  readonly childName: string | null;
  readonly color: string | null;
  readonly owned: boolean;
  readonly parentThreadId: string | null;
  readonly path: string;
  readonly threadId: string;
}

/** The top-level thread the user sent to: the one the host lists children under. */
function rootLog(tree: readonly HostThreadLog[]): HostThreadLog {
  const roots = tree.filter(
    ({ parentThreadId, threadId }) =>
      parentThreadId === undefined && tree.some((log) => log.parentThreadId === threadId)
  );
  if (roots.length !== 1) {
    throw new Error(`Expected one delegating root thread, got ${roots.length}`);
  }
  return roots[0] as HostThreadLog;
}

/** How a thread's latest committed run ended, or `running`. */
function latestOutcome(rows: readonly HostLogRow[]): string {
  return foldHostRuns(rows).at(-1)?.status ?? 'running';
}

/** The persona a child thread was delegated under, from its committed origin. */
function personaOf(log: HostThreadLog): string | undefined {
  const started = log.rows[0]?.event;
  return started?.type === 'thread.started' && 'origin' in started
    ? started.origin.persona
    : undefined;
}

async function readExplorerOutcomes(userDataDir: string): Promise<string[]> {
  const tree = await readHostThreadTree(userDataDir);
  const root = rootLog(tree);
  return tree
    .filter((log) => log.parentThreadId === root.threadId && personaOf(log) === 'explore')
    .map(({ rows }) => latestOutcome(rows));
}

async function assertCanvasAndExplorerSiblings(userDataDir: string): Promise<void> {
  const tree = await readHostThreadTree(userDataDir);
  const root = rootLog(tree);
  // The root's canvas is committed host tool state: one version, before the Workers.
  const canvas = root.rows.flatMap(({ event }) =>
    event.type === 'tool.state.updated' && event.key.startsWith('brainstrike.manageCanvas/')
      ? [event.value]
      : []
  );
  expect(canvas).toMatchObject([{ title: CANVAS_TITLE, version: 1 }]);
  expect(
    tree.filter((log) => log.parentThreadId === root.threadId && personaOf(log) === 'explore')
  ).toHaveLength(2);
}

async function readWorkerCheckpoints(userDataDir: string): Promise<CheckpointRow[]> {
  const tree = await readHostThreadTree(userDataDir);
  const root = rootLog(tree);
  return tree
    .flatMap((log) => {
      const runIds = new Set(foldHostRuns(log.rows).map(({ runId }) => runId));
      return log.rows.flatMap(({ event }) =>
        event.type === 'workspace.edit.recorded' &&
        (event.path === 'alpha-output.txt' || event.path === 'beta-output.txt') &&
        (log.threadId === root.threadId || log.parentThreadId === root.threadId)
          ? [
              {
                childName: log.child?.callSign ?? null,
                color: log.child?.color ?? null,
                owned: runIds.has(event.runId),
                parentThreadId: log.parentThreadId ?? null,
                path: event.path,
                threadId: log.threadId,
              },
            ]
          : []
      );
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

// Only the external model endpoint is scripted. The assistant host, native
// approval, Mastra delegation, PGlite persistence and file mutations stay real.
test('canvas approval resume starts two new Workers on the same root turn @smoke', async ({
  electron,
}, testInfo) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-canvas-workers-'));
  await writeFile(path.join(workspace, 'first.txt'), 'FIRST_EXPLORER_EVIDENCE');
  await writeFile(path.join(workspace, 'second.txt'), 'SECOND_EXPLORER_EVIDENCE');
  let canvasLoaded = false;
  let canvasCreated = false;
  let workersDispatched = false;
  const provider = await startModelProviderShim(({ messages, toolNames }) => {
    if (toolNames.length === 0) {
      return { finalText: CANVAS_TITLE };
    }
    const history = JSON.stringify(messages);
    const userTask = JSON.stringify(
      messages.filter(
        (message) =>
          message &&
          typeof message === 'object' &&
          'role' in message &&
          message.role === 'user' &&
          !JSON.stringify(message).includes('Background invocations of this turn')
      )
    );
    if (userTask.includes('EXPLORER_FIRST_TASK')) {
      return {
        finalText: 'FIRST_EXPLORER_DONE',
        toolCall: { arguments: { path: 'first.txt' }, name: 'brainstrike_readWorkspaceFile' },
      };
    }
    if (userTask.includes('EXPLORER_SECOND_TASK')) {
      return {
        finalText: 'SECOND_EXPLORER_DONE',
        toolCall: { arguments: { path: 'second.txt' }, name: 'brainstrike_readWorkspaceFile' },
      };
    }
    for (const worker of WORKERS) {
      if (userTask.includes(worker.marker)) {
        expect(toolNames).toContain('brainstrike_writeWorkspaceFile');
        return {
          finalText: `${worker.marker}_DONE`,
          toolCall: {
            arguments: { content: worker.content, path: worker.path },
            name: 'brainstrike_writeWorkspaceFile',
          },
        };
      }
    }
    if (history.includes('Background invocations of this turn')) {
      if (!(canvasLoaded || toolNames.includes('brainstrike_manageCanvas'))) {
        canvasLoaded = true;
        return {
          finalText: 'ROOT_CANVAS_CREATED',
          // This stateful script advances explicitly; earlier delegation
          // results remain after the owning input when context is refreshed.
          ignorePriorToolResults: true,
          toolCall: {
            arguments: { toolName: 'brainstrike_manageCanvas' },
            name: 'load_tool',
          },
        };
      }
      if (!canvasCreated) {
        expect(toolNames).toContain('brainstrike_manageCanvas');
        canvasCreated = true;
        return {
          finalText: 'ROOT_CANVAS_CREATED',
          ignorePriorToolResults: true,
          toolCall: {
            arguments: {
              action: 'create',
              canvasId: 'provider-ignored-canvas-id',
              html: CANVAS_HTML,
              newString: '',
              oldString: '.',
              title: CANVAS_TITLE,
            },
            name: 'brainstrike_manageCanvas',
          },
        };
      }
      if (!workersDispatched) {
        expect(toolNames).toContain('agent-worker');
        workersDispatched = true;
        return {
          finalText: 'ROOT_WORKERS_STARTED',
          ignorePriorToolResults: true,
          toolCalls: WORKERS.map((worker) => ({
            arguments: {
              _background: { enabled: true },
              prompt: `${worker.marker}: Create ${worker.path} with the requested disposable content.`,
            },
            name: 'agent-worker',
          })),
        };
      }
      return { finalText: 'ROOT_WORKERS_STARTED' };
    }
    expect(toolNames).toContain('agent-explore');
    return {
      finalText: 'ROOT_WAITING_FOR_EXPLORERS',
      toolCalls: [
        {
          arguments: {
            _background: { enabled: true },
            prompt: 'EXPLORER_FIRST_TASK: read first.txt.',
          },
          name: 'agent-explore',
        },
        {
          arguments: {
            _background: { enabled: true },
            prompt: 'EXPLORER_SECOND_TASK: read second.txt.',
          },
          name: 'agent-explore',
        },
      ],
    };
  });
  const environment = {
    BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
    BRAINSTRIKE_OPENROUTER_API_KEY: 'isolated-canvas-workers-key',
    OPENROUTER_BASE_URL: provider.baseUrl,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  const failures: unknown[] = [];
  // A reload must not call the model; count generations, not metadata reads.
  const modelCalls = (): number => provider.requests().length;
  try {
    const window = await electron.ensureWindow();
    const assistantFailures: string[] = [];
    const recordAssistantFailure = (failure: string): void => {
      assistantFailures.push(failure);
    };
    window.on('console', (message) => {
      if (
        /local thread history load failed|Assistant replay cannot replace durable message/iu.test(
          message.text()
        )
      ) {
        recordAssistantFailure(message.text());
      }
    });
    const assertAssistantHealthy = (): void => {
      if (assistantFailures.length > 0) {
        throw new Error(
          `Assistant failed during approval resume: ${assistantFailures.join(' | ')}`
        );
      }
    };
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window, {
      compositeModelKey: 'openrouter::openai/gpt-5.4',
      provider: 'openrouter',
    });
    await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
    await new HomePage(window).openSettings();
    await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
    await window
      .getByRole('combobox', { exact: true, name: 'Read permission' })
      .selectOption('ask');
    await window.getByTestId('permission-policy-edit').selectOption('ask');
    await ensureAssistantShellVisible(window);
    const root = window.getByRole('region', { exact: true, name: 'Assistant' });
    await root
      .getByRole('textbox', { name: 'Message input' })
      .fill(
        'Ask two Explorers to read first.txt and second.txt, create a canvas, then start two Workers to create alpha-output.txt and beta-output.txt.'
      );
    await root.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(root.getByTestId('approval-strip-count-read')).toContainText('2 reads');
    await root.getByTestId('approval-strip-grant-read').click();
    const canvasApproval = root.getByRole('button', {
      exact: true,
      name: 'Approve brainstrike.manageCanvas',
    });
    await expect(canvasApproval).toBeVisible();
    const userDataDir = electron.getUserDataDir();
    await expect
      .poll(async () => await readExplorerOutcomes(userDataDir))
      .toEqual(['completed', 'completed']);
    const rootThreadId = rootLog(await readHostThreadTree(userDataDir)).threadId;
    const pausedModelCalls = modelCalls();
    await window.reload();
    await ensureAssistantShellVisible(window);
    await expect(canvasApproval).toBeVisible();
    expect(modelCalls()).toBe(pausedModelCalls);
    await canvasApproval.click();
    await expect(root.getByTestId('approval-strip-count-edit')).toContainText('2 edits');
    await assertCanvasAndExplorerSiblings(userDataDir);
    for (const worker of WORKERS) {
      await expect(readFile(path.join(workspace, worker.path), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    await root.getByTestId('approval-strip-grant-edit').click();
    await expect(root.getByText('ROOT_WORKERS_STARTED', { exact: true })).toBeVisible();
    await expect
      .poll(
        async () => {
          assertAssistantHealthy();
          return (await readWorkerCheckpoints(userDataDir)).length;
        },
        { timeout: 45_000 }
      )
      .toBe(2);
    const checkpoints = await readWorkerCheckpoints(userDataDir);
    expect(checkpoints.map((row) => row.path)).toEqual(WORKERS.map((worker) => worker.path));
    expect(new Set(checkpoints.map((row) => row.threadId)).size).toBe(2);
    for (const checkpoint of checkpoints) {
      expect(checkpoint).toMatchObject({
        childName: expect.stringMatching(/^[A-Z][a-z]+-[a-f0-9]{6}$/),
        color: expect.stringMatching(/^family:/u),
        owned: true,
        parentThreadId: rootThreadId,
      });
      expect(checkpoint.threadId).not.toBe(rootThreadId);
    }
    for (const worker of WORKERS) {
      expect(await readFile(path.join(workspace, worker.path), 'utf8')).toBe(worker.content);
    }
    expect(
      provider.transcript().filter((turn) => turn.decision === 'tool:agent-worker+agent-worker')
    ).toHaveLength(1);
    expect(
      provider
        .transcript()
        .filter((turn) => turn.decision === 'tool:brainstrike_writeWorkspaceFile')
    ).toHaveLength(2);
    const completedThreadIds = [rootThreadId, ...checkpoints.map((row) => row.threadId)];
    // The root's visible answer can precede its run's committed end; wait for
    // the root and both Workers to end before closing the host.
    await expect
      .poll(
        async () => {
          assertAssistantHealthy();
          const tree = await readHostThreadTree(userDataDir);
          return completedThreadIds.map((threadId) =>
            latestOutcome(tree.find((log) => log.threadId === threadId)?.rows ?? [])
          );
        },
        { timeout: 45_000 }
      )
      .toEqual(['completed', 'completed', 'completed']);
    // One user send; the read, canvas and edit decisions answered the same turn:
    // no second root prompt or replayed leg was needed to start the Workers.
    const rootRows = rootLog(await readHostThreadTree(userDataDir)).rows;
    expect(
      rootRows.filter(
        ({ event }) => event.type === 'command.accepted' && event.method === 'run/start'
      )
    ).toHaveLength(1);
    expect(assistantFailures).toEqual([]);
  } catch (error) {
    failures.push(error);
    try {
      await testInfo.attach('provider-transcript', {
        body: JSON.stringify(provider.transcript()),
        contentType: 'application/json',
      });
    } catch (attachmentError) {
      failures.push(attachmentError);
    }
  } finally {
    for (const key of Object.keys(environment)) {
      try {
        const value = previous[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    for (const cleanup of [
      async () => electron.dispose(),
      async () => provider.close(),
      async () => rm(workspace, { force: true, recursive: true }),
    ]) {
      try {
        await cleanup();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Canvas worker test and cleanup failed', {
      cause: failures[0],
    });
  }
});
