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

const WORKERS = [
  { input: 'alpha.txt', marker: 'PARKED_ALPHA', output: 'alpha-output.txt' },
  { input: 'beta.txt', marker: 'PARKED_BETA', output: 'beta-output.txt' },
  { input: 'gamma.txt', marker: 'PARKED_GAMMA', output: 'gamma-output.txt' },
] as const;
const ROOT_OUTPUT = 'root-output.txt';

async function readNativeState(
  page: Page,
  rootThreadId: string
): Promise<{
  approvalEvents: { toolName: string | null; threadId: string }[];
  checkpoints: { path: string; threadId: string }[];
  tasks: { error: unknown; status: string }[];
  children: { status: string; threadId: string }[];
  rootFinalMessages: { id: string; content: unknown }[];
}> {
  return await page.evaluate(async (threadId) => {
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
    const [taskRows, childRows, checkpointRows, approvalRows, rootFinalRows] = await Promise.all([
      api.db.query(
        'SELECT status, error FROM mastra_background_tasks WHERE thread_id = $1 ORDER BY tool_call_id',
        [threadId]
      ),
      api.db.query(
        `SELECT DISTINCT ON (child.thread_id) child.thread_id AS "threadId", run.status
           FROM brainstrike_delegated_conversations child
           JOIN brainstrike_assistant_thread_runs run ON run.thread_id = child.thread_id
          WHERE child.parent_thread_id = $1
          ORDER BY child.thread_id, run.started_at DESC, run.id DESC`,
        [threadId]
      ),
      api.db.query(
        `SELECT checkpoint.path, checkpoint.thread_id AS "threadId"
           FROM brainstrike_assistant_edit_checkpoints checkpoint
           LEFT JOIN brainstrike_delegated_conversations child ON child.thread_id = checkpoint.thread_id
          WHERE checkpoint.thread_id = $1 OR child.parent_thread_id = $1
          ORDER BY checkpoint.path`,
        [threadId]
      ),
      api.db.query(
        `SELECT event.thread_id AS "threadId", event.metadata->>'toolName' AS "toolName"
           FROM brainstrike_assistant_run_events event
          WHERE event.kind = 'tool.approval.requested'
            AND (event.thread_id = $1 OR event.thread_id IN (
              SELECT child.thread_id FROM brainstrike_delegated_conversations child
              WHERE child.parent_thread_id = $1
            ))
          ORDER BY event.occurred_at, event.id`,
        [threadId]
      ),
      api.db.query(
        `SELECT id, content FROM mastra_messages
          WHERE thread_id = $1 AND role = 'assistant'
            AND (content::text LIKE '%ROOT_WRITE_COMPLETE%'
              OR content::text LIKE '%ROOT_AND_WORKERS_COMPLETE%')
          ORDER BY "createdAt", id`,
        [threadId]
      ),
    ]);
    return {
      approvalEvents: approvalRows.rows as { toolName: string | null; threadId: string }[],
      checkpoints: checkpointRows.rows as { path: string; threadId: string }[],
      children: childRows.rows as { status: string; threadId: string }[],
      rootFinalMessages: rootFinalRows.rows as { id: string; content: unknown }[],
      tasks: taskRows.rows as { error: unknown; status: string }[],
    };
  }, rootThreadId);
}

// The provider boundary is scripted; Electron, Mastra, permission decisions,
// PGlite and both root and Worker filesystem tools remain production code.
test('root approval resumes while three Workers are parked, then live grants complete their reads and writes @smoke', async ({
  electron,
}, testInfo) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-parked-workers-'));
  for (const worker of WORKERS) {
    await writeFile(path.join(workspace, worker.input), `${worker.marker}_INPUT\n`);
  }
  let releaseRootContinuation: () => void = () => {
    throw new Error('Root continuation gate was not initialized');
  };
  const rootContinuationGate = new Promise<void>((resolve) => {
    releaseRootContinuation = resolve;
  });
  let rootContinuationRequested = false;
  let workersDispatched = false;
  let rootWriteRequested = false;
  let rootFinalRequests = 0;
  const failures: unknown[] = [];
  const requireAdvertisedTool = (toolNames: readonly string[], name: string): void => {
    try {
      expect(toolNames).toContain(name);
    } catch (error) {
      failures.push(error);
      throw error;
    }
  };
  const provider = await startModelProviderShim(({ messages, toolNames }) => {
    if (toolNames.length === 0) {
      return { finalText: 'Parked Workers' };
    }
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
    for (const worker of WORKERS) {
      if (userTask.includes(worker.marker)) {
        requireAdvertisedTool(toolNames, 'brainstrike_readWorkspaceFile');
        requireAdvertisedTool(toolNames, 'brainstrike_writeWorkspaceFile');
        return {
          finalText: `${worker.marker}_DONE`,
          toolCallStages: [
            [{ arguments: { path: worker.input }, name: 'brainstrike_readWorkspaceFile' }],
            [
              {
                arguments: { content: `${worker.marker}_OUTPUT\n`, path: worker.output },
                name: 'brainstrike_writeWorkspaceFile',
              },
            ],
          ],
        };
      }
    }
    requireAdvertisedTool(toolNames, 'agent-worker');
    requireAdvertisedTool(toolNames, 'brainstrike_writeWorkspaceFile');
    const toolResults = messages.filter(
      (message) =>
        message && typeof message === 'object' && 'role' in message && message.role === 'tool'
    );
    if (toolResults.some((result) => JSON.stringify(result).includes('bytesWritten'))) {
      rootContinuationRequested = true;
    }
    if (!workersDispatched) {
      workersDispatched = true;
      return {
        finalText: 'ROOT_WORKERS_DISPATCHED',
        toolCalls: WORKERS.map((worker) => ({
          arguments: {
            _background: { enabled: true },
            prompt: `${worker.marker}: read ${worker.input}, then write ${worker.output}.`,
          },
          name: 'agent-worker',
        })),
      };
    }
    if (!rootWriteRequested) {
      rootWriteRequested = true;
      return {
        finalText: 'ROOT_AND_WORKERS_COMPLETE',
        ignorePriorToolResults: true,
        toolCall: {
          arguments: { content: 'ROOT_OUTPUT\n', path: ROOT_OUTPUT },
          name: 'brainstrike_writeWorkspaceFile',
        },
      };
    }
    rootFinalRequests += 1;
    // The root finishes the approved write, then its background ledger wakes
    // a separate model turn after all three Workers return.
    return {
      beforeFinalText: rootContinuationGate,
      finalText: rootFinalRequests === 1 ? 'ROOT_WRITE_COMPLETE' : 'ROOT_AND_WORKERS_COMPLETE',
    };
  });
  const environment = {
    BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
    BRAINSTRIKE_OPENROUTER_API_KEY: 'isolated-parked-workers-key',
    OPENROUTER_BASE_URL: provider.baseUrl,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  try {
    const window = await electron.ensureWindow();
    const assistantPosts: { body: unknown; path: string }[] = [];
    const assistantFailures: string[] = [];
    window.on('request', (request) => {
      const requestPath = new URL(request.url()).pathname;
      if (
        request.method() === 'POST' &&
        (requestPath === '/assistant' || requestPath === '/assistant/decide')
      ) {
        assistantPosts.push({ body: request.postDataJSON(), path: requestPath });
      }
    });
    window.on('response', (response) => {
      const requestPath = new URL(response.url()).pathname;
      if (requestPath.startsWith('/assistant') && response.status() >= 500) {
        assistantFailures.push(`${requestPath}: HTTP ${response.status()}`);
      }
    });
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
      .fill('Start three Workers, then create a root report while they work.');
    await root.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect
      .poll(() => assistantPosts.filter((request) => request.path === '/assistant').length)
      .toBe(1);
    const initialPost = assistantPosts.find((request) => request.path === '/assistant');
    const rootThreadId = (
      initialPost?.body as { data?: { memory?: { threadId?: unknown } } } | undefined
    )?.data?.memory?.threadId;
    if (typeof rootThreadId !== 'string') {
      throw new Error('Initial assistant request lacked a root thread ID');
    }
    const rootApproval = root.getByRole('button', {
      exact: true,
      name: 'Approve brainstrike.writeWorkspaceFile',
    });
    await expect
      .poll(async () => {
        const { tasks } = await readNativeState(window, rootThreadId);
        const failed = tasks.filter((task) =>
          ['failed', 'timed_out', 'cancelled'].includes(task.status)
        );
        if (failed.length > 0) {
          return `Background tasks failed: ${JSON.stringify(failed)}`;
        }
        return (await rootApproval.isVisible()) ? 'approval' : 'pending';
      })
      .toBe('approval');
    await expect
      .poll(
        async () => (await readNativeState(window, rootThreadId)).tasks.map((task) => task.status),
        { timeout: 45_000 }
      )
      .toEqual(['suspended', 'suspended', 'suspended']);
    const beforeApproval = await readNativeState(window, rootThreadId);
    expect(beforeApproval.checkpoints).toEqual([]);
    for (const output of [ROOT_OUTPUT, ...WORKERS.map((worker) => worker.output)]) {
      await expect(readFile(path.join(workspace, output), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    await rootApproval.click();
    await expect.poll(() => rootContinuationRequested).toBe(true);
    expect(await readFile(path.join(workspace, ROOT_OUTPUT), 'utf8')).toBe('ROOT_OUTPUT\n');
    await expect(root.getByTestId('approval-strip-count-read')).toContainText('3 reads');
    await root.getByTestId('approval-strip-grant-read').click();
    await expect
      .poll(
        () =>
          provider
            .transcript()
            .filter((turn) => turn.decision === 'tool:brainstrike_writeWorkspaceFile').length,
        { timeout: 45_000 }
      )
      .toBe(4);
    await expect
      .poll(
        async () => (await readNativeState(window, rootThreadId)).tasks.map((task) => task.status),
        { timeout: 45_000 }
      )
      .toEqual(['suspended', 'suspended', 'suspended']);
    const parkedWriteState = await readNativeState(window, rootThreadId);
    await testInfo.attach('parked-worker-write-state', {
      body: JSON.stringify(parkedWriteState),
      contentType: 'application/json',
    });
    // These approvals must publish while the resumed root leg is still awaiting
    // its provider response; otherwise the user cannot act on live child work.
    await expect(root.getByTestId('approval-strip-count-edit')).toContainText('3 edits');
    for (const worker of WORKERS) {
      await expect(readFile(path.join(workspace, worker.output), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    await root.getByTestId('approval-strip-grant-edit').click();
    // Native task completion and host consumption of the child's terminal are
    // separate commits. Require both while root synthesis is still held.
    await expect
      .poll(
        async () => {
          const state = await readNativeState(window, rootThreadId);
          return {
            children: state.children.map((child) => child.status),
            tasks: state.tasks.map((task) => task.status),
          };
        },
        { timeout: 45_000 }
      )
      .toEqual({
        children: ['completed', 'completed', 'completed'],
        tasks: ['completed', 'completed', 'completed'],
      });
    const settled = await readNativeState(window, rootThreadId);
    expect(settled.children).toHaveLength(3);
    expect(settled.children.every((child) => child.status === 'completed')).toBe(true);
    expect(settled.checkpoints.map((checkpoint) => checkpoint.path)).toEqual([
      'alpha-output.txt',
      'beta-output.txt',
      'gamma-output.txt',
      ROOT_OUTPUT,
    ]);
    expect(new Set(settled.checkpoints.map((checkpoint) => checkpoint.threadId)).size).toBe(4);
    for (const worker of WORKERS) {
      expect(await readFile(path.join(workspace, worker.output), 'utf8')).toBe(
        `${worker.marker}_OUTPUT\n`
      );
    }
    releaseRootContinuation();
    await expect(root.getByText('ROOT_WRITE_COMPLETE', { exact: true })).toHaveCount(1);
    await expect(root.getByText('ROOT_AND_WORKERS_COMPLETE', { exact: true })).toBeVisible();
    await expect(root.getByText('ROOT_AND_WORKERS_COMPLETE', { exact: true })).toHaveCount(1);
    expect(rootFinalRequests).toBe(2);
    expect(provider.transcript().filter((turn) => turn.decision === 'final-text')).toHaveLength(5);
    const finalState = await readNativeState(window, rootThreadId);
    expect(finalState.rootFinalMessages).toHaveLength(2);
    expect(JSON.stringify(finalState.rootFinalMessages[0]?.content)).toContain(
      'ROOT_WRITE_COMPLETE'
    );
    expect(JSON.stringify(finalState.rootFinalMessages[1]?.content)).toContain(
      'ROOT_AND_WORKERS_COMPLETE'
    );
    expect(
      provider
        .transcript()
        .filter((turn) => turn.decision === 'tool:brainstrike_writeWorkspaceFile')
    ).toHaveLength(4);
    expect(assistantFailures).toEqual([]);
  } catch (error) {
    failures.push(error);
    await testInfo.attach('provider-transcript', {
      body: JSON.stringify(provider.transcript()),
      contentType: 'application/json',
    });
  } finally {
    releaseRootContinuation();
    for (const key of Object.keys(environment)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const cleanup of [
      async () => electron.dispose(),
      async () => provider.close(),
      async () => rm(workspace, { force: true, recursive: true }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Parked Worker test and cleanup failed');
  }
});
