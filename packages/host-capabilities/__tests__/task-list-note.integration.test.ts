import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import {
  attachAgentHost,
  type HostLogRow,
  type HostPlatform,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedToolSequence } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import {
  createSharedNativeHostTools,
  ReadWorkspaceFileCursorRegistry,
} from '../src/native-tools/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

type Prompt = NonNullable<Parameters<typeof scriptedToolSequence>[1]>[number];

/** The system text of one recorded request. */
function system(prompt: Prompt | undefined): string {
  return (prompt ?? [])
    .flatMap((message) => (message.role === 'system' ? [message.content] : []))
    .join('\n');
}

test('the next step carries the task list the run committed, as the legacy <current-task-list> note', async () => {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'bs-task-list-note-')));
  cleanup.push(() => rm(dataRoot, { force: true, recursive: true }));
  const tools = createSharedNativeHostTools({
    ids: [NATIVE_TOOL_ID.manageTaskList],
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
    runtime: { model: 'scripted', provider: 'openai', workspaceRoots: [] },
  });
  const prompts: Prompt[] = [];
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: true }),
    resolveModel: async () =>
      scriptedToolSequence(
        [
          {
            input: {
              tasks: [
                {
                  activeForm: 'Drafting the note',
                  content: 'Draft the note',
                  status: 'in_progress',
                },
              ],
            },
            toolId: NATIVE_TOOL_ID.manageTaskList.replace('.', '_'),
          },
        ],
        prompts
      ),
    tools,
  };
  const started = await startAgentHost({ lifetime: 'persistent', root: dataRoot }, platform);
  const client = await attachAgentHost(started.record);
  cleanup.push(async () => {
    await client.close();
    await started.close();
  });
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Plan, then answer',
    threadId,
  });
  let rows: readonly HostLogRow[] = [];
  await expect
    .poll(
      async () => {
        rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
        return rows.some((row) => row.event.type === 'run.finished' && row.event.runId === runId);
      },
      { timeout: 30_000 }
    )
    .toBe(true);

  expect(rows.find((row) => row.event.type === 'run.finished')?.event).toMatchObject({
    outcome: 'completed',
  });
  expect(prompts).toHaveLength(2);
  expect(system(prompts[0])).not.toContain('<current-task-list');
  expect(system(prompts[1])).toContain('<current-task-list count="1">');
  expect(system(prompts[1])).toContain('[in_progress] Draft the note');
});
