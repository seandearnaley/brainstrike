import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { foldHostRuns } from '@brainstrike/agent-host/thread-view';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { type ModelProviderRequest, startModelProviderShim } from './utils/model-provider-shim';

const WORKERS = [
  { input: 'alpha.txt', marker: 'PARKED_ALPHA', output: 'alpha-output.txt' },
  { input: 'beta.txt', marker: 'PARKED_BETA', output: 'beta-output.txt' },
  { input: 'gamma.txt', marker: 'PARKED_GAMMA', output: 'gamma-output.txt' },
] as const;
const ROOT_OUTPUT = 'root-output.txt';
const ROOT_PROMPT = 'Start three Workers, then create a root report while they work.';

function hasRole(message: unknown, role: string): boolean {
  return (
    typeof message === 'object' && message !== null && 'role' in message && message.role === role
  );
}

/** The provider turn that opens the root run: its prompt is the latest user message and no tool has run yet. */
function isRootOpeningTurn({ messages, toolNames }: ModelProviderRequest): boolean {
  return (
    toolNames.length > 0 &&
    !messages.some((message) => hasRole(message, 'tool')) &&
    JSON.stringify(messages.filter((message) => hasRole(message, 'user')).at(-1)).includes(
      ROOT_PROMPT
    )
  );
}

/**
 * BST-1932: the delegation tree as the agent host committed it. Each Worker as
 * its parent's sidebar shows it (needs-input while it waits on an approval),
 * how its runs ended, every recorded edit, and the root's final answers.
 */
async function readHostState(userDataDir: string) {
  const tree = await readHostThreadTree(userDataDir);
  const rootLog = tree.find(({ parentThreadId }) => parentThreadId === undefined);
  const workers = tree.filter(({ parentThreadId }) => parentThreadId === rootLog?.threadId);
  return {
    checkpoints: tree
      .flatMap(({ rows, threadId }) =>
        rows.flatMap(({ event }) =>
          event.type === 'workspace.edit.recorded' ? [{ path: event.path, threadId }] : []
        )
      )
      .sort((a, b) => a.path.localeCompare(b.path)),
    rootFinalTexts: foldHostRuns(rootLog?.rows ?? [])
      .map(({ text }) => text)
      .filter(
        (text) => text.includes('ROOT_WRITE_COMPLETE') || text.includes('ROOT_AND_WORKERS_COMPLETE')
      ),
    workers: workers.map(({ child, rows }) => ({
      outcomes: rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : [])),
      status: child?.status,
    })),
  };
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
    const assistantFailures: string[] = [];
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
    await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
    await new HomePage(window).openSettings();
    await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
    await window
      .getByRole('combobox', { exact: true, name: 'Read permission' })
      .selectOption('ask');
    await window.getByTestId('permission-policy-edit').selectOption('ask');
    await ensureAssistantShellVisible(window);
    const root = window.getByRole('region', { exact: true, name: 'Assistant' });
    await root.getByRole('textbox', { name: 'Message input' }).fill(ROOT_PROMPT);
    await root.getByRole('button', { exact: true, name: 'Send' }).click();
    // One Send admits one root run: exactly one provider turn opens it (the
    // root prompt with no tool history yet). A second admission would add another.
    await expect.poll(() => provider.requests().filter(isRootOpeningTurn).length).toBe(1);
    const userDataDir = electron.getUserDataDir();
    const rootApproval = root.getByRole('button', {
      exact: true,
      name: 'Approve brainstrike.writeWorkspaceFile',
    });
    await expect
      .poll(async () => {
        const { workers } = await readHostState(userDataDir);
        const failed = workers.filter(({ outcomes }) =>
          outcomes.some((outcome) => outcome !== 'completed')
        );
        if (failed.length > 0) {
          return `Workers ended early: ${JSON.stringify(failed)}`;
        }
        return (await rootApproval.isVisible()) ? 'approval' : 'pending';
      })
      .toBe('approval');
    // Each Worker waits on its read approval.
    await expect
      .poll(async () => (await readHostState(userDataDir)).workers.map(({ status }) => status), {
        timeout: 45_000,
      })
      .toEqual(['needs-input', 'needs-input', 'needs-input']);
    const beforeApproval = await readHostState(userDataDir);
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
    // Each Worker now waits on its write approval.
    await expect
      .poll(async () => (await readHostState(userDataDir)).workers.map(({ status }) => status), {
        timeout: 45_000,
      })
      .toEqual(['needs-input', 'needs-input', 'needs-input']);
    const parkedWriteState = await readHostState(userDataDir);
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
          const state = await readHostState(userDataDir);
          return {
            outcomes: state.workers.map(({ outcomes }) => outcomes),
            statuses: state.workers.map(({ status }) => status),
          };
        },
        { timeout: 45_000 }
      )
      .toEqual({
        outcomes: [['completed'], ['completed'], ['completed']],
        statuses: ['idle', 'idle', 'idle'],
      });
    const settled = await readHostState(userDataDir);
    expect(settled.workers).toHaveLength(3);
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
    // The host also titles the thread once: a request that advertises no tools.
    const titleRequests = new Set(
      provider
        .requests()
        .filter(({ toolNames }) => toolNames.length === 0)
        .map(({ requestIndex }) => requestIndex)
    );
    expect(titleRequests.size).toBe(1);
    // Two root answers and three Worker answers.
    expect(
      provider
        .transcript()
        .filter((turn) => turn.decision === 'final-text' && !titleRequests.has(turn.requestIndex))
    ).toHaveLength(5);
    // The root's turn answered the write; one wake answered all three Workers.
    const finalState = await readHostState(userDataDir);
    expect(finalState.rootFinalTexts).toHaveLength(2);
    expect(finalState.rootFinalTexts[0]).toContain('ROOT_WRITE_COMPLETE');
    expect(finalState.rootFinalTexts[1]).toContain('ROOT_AND_WORKERS_COMPLETE');
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
