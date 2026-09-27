import { MessageList } from '@mastra/core/agent';
import type { BackgroundTask } from '@mastra/core/background-tasks';
import type { ProcessInputStepArgs, ProcessLLMRequestArgs } from '@mastra/core/processors';
import { afterEach, expect, it, vi } from 'vitest';
import { createActiveBackgroundResultsProcessor } from '../active-background-results-processor';
import type { MastraAgentRuntime } from '../agent-runtime';

afterEach(() => vi.useRealTimers());

function task(id: string, status: BackgroundTask['status'], runId = 'current'): BackgroundTask {
  return {
    agentId: 'root',
    args: { prompt: `Survey ${id}` },
    createdAt: new Date(0),
    id,
    maxRetries: 0,
    result: { text: `${id}-report` },
    retryCount: 0,
    runId,
    status,
    timeoutMs: 1000,
    toolCallId: `call-${id}`,
    toolName: 'agent-explore',
  };
}

function fixture(tasks: BackgroundTask[]) {
  const listTasks = vi.fn(async () => ({ tasks, total: tasks.length }));
  const runtime = {
    backgroundTaskManager: { listTasks },
    conversationBinding: {
      readBackgroundGeneration: async () => ({
        generationRunId: 'generation',
        nativeRunIds: ['current'],
      }),
    },
    delegationToolPersonas: new Map([['agent-explore', 'explore']]),
    personasById: new Map([['explore', { label: 'Explorer' }]]),
  } as unknown as MastraAgentRuntime;
  const processor = createActiveBackgroundResultsProcessor(
    runtime,
    { memory: { resourceId: 'owner', threadId: 'root' } },
    undefined
  );
  if (!processor?.processInputStep) {
    throw new Error('Missing input-step processor');
  }
  const messageList = new MessageList({ resourceId: 'owner', threadId: 'root' });
  messageList.add({ content: 'Original task', role: 'user' }, 'input');
  const args = {
    messageList,
    messages: [],
    retryCount: 0,
    state: {},
    stepNumber: 0,
  } as unknown as ProcessInputStepArgs;
  return {
    args,
    listTasks,
    messageList,
    processor,
    runtime,
    step: () => processor.processInputStep(args),
  };
}

it('acknowledges only terminal context retained in the actual model prompt', async () => {
  const f = fixture([task('alpha', 'completed'), task('beta', 'running')]);
  await f.step();
  f.processor.processLLMRequest({
    prompt: [],
    state: f.args.state,
  } as unknown as ProcessLLMRequestArgs);
  expect(f.processor.hasPresented('alpha')).toBe(false);
  const text = f.messageList.get.all.db().at(-1)?.content.parts[0];
  if (text?.type !== 'text') {
    throw new Error('Missing context text');
  }
  f.processor.processLLMRequest({
    prompt: [{ content: [text], role: 'user' }],
    state: f.args.state,
  } as unknown as ProcessLLMRequestArgs);
  expect(f.processor.hasPresented('alpha')).toBe(true);
  expect(f.processor.hasPresented('beta')).toBe(false);
});

it('replaces current-generation context without promoting results to system authority or persisting a user turn', async () => {
  const rows = [
    task('alpha', 'completed'),
    task('beta', 'running'),
    task('old', 'completed', 'previous'),
  ];
  const f = fixture(rows);
  await f.step();
  expect(JSON.stringify(f.messageList.get.all.db())).toContain('1 still running');
  expect(JSON.stringify(f.messageList.get.all.db())).not.toContain('old-report');
  expect(JSON.stringify(f.messageList.get.all.db())).not.toContain('beta-report');
  rows[1] = task('beta', 'completed');
  await f.step();
  const messages = f.messageList.get.all.db();
  expect(
    messages.filter((message) => message.id.startsWith('active-background-results:'))
  ).toHaveLength(1);
  expect(JSON.stringify(messages)).toContain('Nothing is still running');
  expect(JSON.stringify(messages)).not.toContain('1 still running');
  expect(JSON.stringify(messages)).toContain('beta-report');
  expect(f.messageList.getAllSystemMessages()).toEqual([]);
  expect(f.messageList.drainUnsavedMessages()).toHaveLength(1);
  expect(f.listTasks).toHaveBeenCalledWith({ resourceId: 'owner', threadId: 'root' });
});

it.each(['failed', 'timed_out', 'cancelled'] as const)(
  'delivers %s without treating a parked sibling as finished',
  async (status) => {
    const f = fixture([task('alpha', status), task('beta', 'suspended')]);
    await f.step();
    const prompt = JSON.stringify(f.messageList.get.all.db());
    expect(prompt).toContain('1 still running');
    expect(prompt).not.toContain('Nothing is still running');
    expect(prompt).not.toContain('alpha-report');
    expect(prompt).toContain('error-text');
    expect(prompt).toContain(status === 'timed_out' ? 'timed out' : status);
  }
);

it('propagates a failed durable read and excludes child-runtime legs', async () => {
  const f = fixture([]);
  f.listTasks.mockRejectedValueOnce(new Error('ledger unavailable'));
  await expect(f.step()).rejects.toThrow('ledger unavailable');
  expect(f.messageList.get.all.db()).toHaveLength(1);
  expect(
    createActiveBackgroundResultsProcessor(
      { ...f.runtime, childExecution: {} as NonNullable<MastraAgentRuntime['childExecution']> },
      undefined,
      undefined
    )
  ).toBeUndefined();
});

it('keeps unchanged background context before the assistant response instead of posing a new user turn', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T20:36:00Z'));
  const f = fixture([task('alpha', 'completed')]);
  await f.step();
  const notice = f.messageList.get.all.db().at(-1);
  if (!notice) {
    throw new Error('Missing context');
  }
  vi.setSystemTime(new Date('2026-09-27T20:36:01Z'));
  f.messageList.add(
    { content: 'Working memory updated.', id: 'memory-update', role: 'assistant' },
    'response'
  );
  vi.setSystemTime(new Date('2026-09-27T20:36:02Z'));
  await f.step();
  vi.useRealTimers();
  const messages = f.messageList.get.all.db();
  expect(messages.map((message) => message.id)).toEqual([
    expect.any(String),
    notice.id,
    'memory-update',
  ]);
});

it('retains the input anchor when compaction removes the input and context, without moving evidence after the response', async () => {
  const f = fixture([task('alpha', 'completed')]);
  await f.step();
  const inputIds = f.messageList.get.all.db().map((message) => message.id);
  f.messageList.add(
    {
      content: 'Memory saved.',
      createdAt: new Date(Date.now() + 1000),
      id: 'response',
      role: 'assistant',
    },
    'response'
  );
  f.messageList.removeByIds(inputIds);
  await f.step();
  expect(f.messageList.get.all.db().map((message) => message.id)).toEqual([
    'active-background-results:generation',
    'response',
  ]);
});
