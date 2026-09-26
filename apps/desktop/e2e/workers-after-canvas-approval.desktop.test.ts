import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
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

interface ThreadRunRow {
  readonly completedAt: string | null;
  readonly status: string;
  readonly threadId: string;
}

async function readExplorerRunStatuses(page: Page, rootThreadId: string): Promise<string[]> {
  return await page.evaluate(async (threadId) => {
    const api = (
      globalThis as {
        electronAPI?: {
          db?: {
            query?: (
              sql: string,
              params?: readonly unknown[]
            ) => Promise<{ rows: { status: string }[] }>;
          };
        };
      }
    ).electronAPI;
    if (!api?.db?.query) {
      throw new Error('Native database bridge unavailable');
    }
    return (
      await api.db.query(
        `SELECT DISTINCT ON (child.thread_id) run.status
           FROM brainstrike_delegated_conversations child
           JOIN brainstrike_assistant_thread_runs run ON run.thread_id = child.thread_id
          WHERE child.parent_thread_id = $1
          ORDER BY child.thread_id, run.started_at DESC, run.id DESC`,
        [threadId]
      )
    ).rows.map((row) => row.status);
  }, rootThreadId);
}

async function assertCanvasAndExplorerSiblings(page: Page, rootThreadId: string): Promise<void> {
  await page.evaluate(
    async ({ threadId, title }) => {
      const api = (
        globalThis as {
          electronAPI?: {
            db?: {
              query?: (
                sql: string,
                params?: readonly unknown[]
              ) => Promise<{ rows: Record<string, unknown>[] }>;
            };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Native database bridge unavailable');
      }
      const canvas = await api.db.query(
        'SELECT version FROM brainstrike_canvas_versions WHERE thread_id = $1 AND title = $2',
        [threadId, title]
      );
      if (canvas.rows.length !== 1 || canvas.rows[0]?.['version'] !== 1) {
        throw new Error('Root canvas was not durably created before the Worker dispatch');
      }
      const explorers = await api.db.query(
        `SELECT child.thread_id AS "threadId"
           FROM brainstrike_delegated_conversations child
           JOIN brainstrike_delegated_invocations invocation ON invocation.thread_id = child.thread_id
          WHERE child.parent_thread_id = $1 AND invocation.persona_id = 'explore'
          ORDER BY child.created_at, child.thread_id`,
        [threadId]
      );
      if (explorers.rows.length !== 2) {
        throw new Error(`Expected two persisted Explorer siblings, got ${explorers.rows.length}`);
      }
    },
    { threadId: rootThreadId, title: CANVAS_TITLE }
  );
}

async function readWorkerCheckpoints(page: Page, rootThreadId: string): Promise<CheckpointRow[]> {
  return await page.evaluate(async (threadId) => {
    const api = (
      globalThis as {
        electronAPI?: {
          db?: {
            query?: (
              sql: string,
              params?: readonly unknown[]
            ) => Promise<{ rows: CheckpointRow[] }>;
          };
        };
      }
    ).electronAPI;
    if (!api?.db?.query) {
      throw new Error('Native database bridge unavailable');
    }
    return (
      await api.db.query(
        `SELECT checkpoint.path,
                checkpoint.thread_id AS "threadId",
                child.display_name AS "childName",
                child.color,
                child.parent_thread_id AS "parentThreadId",
                (run.thread_id = checkpoint.thread_id AND run.resource_id = checkpoint.resource_id) AS owned
           FROM brainstrike_assistant_edit_checkpoints checkpoint
           JOIN brainstrike_assistant_thread_runs run ON run.id = checkpoint.run_id
           LEFT JOIN brainstrike_delegated_conversations child ON child.thread_id = checkpoint.thread_id
          WHERE checkpoint.path IN ('alpha-output.txt', 'beta-output.txt')
            AND (child.root_thread_id = $1 OR checkpoint.thread_id = $1)
          ORDER BY checkpoint.path`,
        [threadId]
      )
    ).rows;
  }, rootThreadId);
}

async function readLatestThreadRuns(
  page: Page,
  threadIds: readonly string[]
): Promise<ThreadRunRow[]> {
  if (threadIds.length !== 3) {
    throw new Error('Expected the root and exactly two Worker thread IDs');
  }
  return await page.evaluate(async (ids) => {
    const api = (
      globalThis as {
        electronAPI?: {
          db?: {
            query?: (sql: string, params?: readonly unknown[]) => Promise<{ rows: ThreadRunRow[] }>;
          };
        };
      }
    ).electronAPI;
    if (!api?.db?.query) {
      throw new Error('Native database bridge unavailable');
    }
    return (
      await api.db.query(
        `SELECT DISTINCT ON (thread_id)
                thread_id AS "threadId", status, completed_at AS "completedAt"
           FROM brainstrike_assistant_thread_runs
          WHERE thread_id IN ($1, $2, $3)
          ORDER BY thread_id, started_at DESC, id DESC`,
        ids
      )
    ).rows;
  }, threadIds);
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
  const assistantPosts: unknown[] = [];
  const failures: unknown[] = [];
  try {
    const window = await electron.ensureWindow();
    const assistantFailures: string[] = [];
    const recordAssistantFailure = (failure: string): void => {
      assistantFailures.push(failure);
    };
    window.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/assistant') {
        assistantPosts.push(request.postDataJSON());
      }
    });
    window.on('response', (response) => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.startsWith('/assistant') && response.status() >= 500) {
        recordAssistantFailure(`${pathname}: HTTP ${response.status()}`);
      }
    });
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
    await new HomePage(window).openSettings();
    await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
    await window
      .getByRole('combobox', { exact: true, name: 'Read permission' })
      .selectOption('ask');
    await window.getByTestId('permission-policy-edit').selectOption('ask');
    await ensureAssistantShellVisible(window);
    const root = window.getByTestId('chat-panel');
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
    const initialPost = assistantPosts[0] as
      | { data?: { memory?: { threadId?: unknown } } }
      | undefined;
    const rootThreadId = initialPost?.data?.memory?.threadId;
    if (typeof rootThreadId !== 'string') {
      throw new Error('Initial assistant POST lacked a root thread ID');
    }
    await expect
      .poll(async () => await readExplorerRunStatuses(window, rootThreadId))
      .toEqual(['completed', 'completed']);
    const pausedRootPosts = assistantPosts.length;
    await window.reload();
    await ensureAssistantShellVisible(window);
    await expect(canvasApproval).toBeVisible();
    expect(assistantPosts).toHaveLength(pausedRootPosts);
    await canvasApproval.click();
    await expect(root.getByTestId('approval-strip-count-edit')).toContainText('2 edits');
    await assertCanvasAndExplorerSiblings(window, rootThreadId);
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
          return (await readWorkerCheckpoints(window, rootThreadId)).length;
        },
        { timeout: 45_000 }
      )
      .toBe(2);
    const checkpoints = await readWorkerCheckpoints(window, rootThreadId);
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
    // The root's visible answer can precede its turn-end snapshot and durable
    // run-status update. Wait for those commits before closing the DB host.
    await expect
      .poll(
        async () => {
          assertAssistantHealthy();
          const rows = await readLatestThreadRuns(window, completedThreadIds);
          return completedThreadIds.map((threadId) => {
            const row = rows.find((candidate) => candidate.threadId === threadId);
            return row?.status === 'completed' && row.completedAt ? 'completed' : row?.status;
          });
        },
        { timeout: 45_000 }
      )
      .toEqual(['completed', 'completed', 'completed']);
    const terminalRuns = await readLatestThreadRuns(window, completedThreadIds);
    expect(terminalRuns).toHaveLength(3);
    expect(terminalRuns.every((row) => row.status === 'completed' && row.completedAt)).toBe(true);
    // One user send plus read, canvas, and edit approval actions: no second
    // root prompt or duplicate replay leg was needed to start the Workers.
    expect(assistantPosts).toHaveLength(4);
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
