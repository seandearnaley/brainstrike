import type { BackgroundTask } from '@mastra/core/background-tasks';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { describe, expect, it } from 'vitest';
import {
  createLateBackgroundResultsProcessor,
  LateBackgroundResultsProcessor,
  recordLateOverlayWakeup,
} from '../late-background-results-processor';

type Prompt = ProcessLLMRequestArgs['prompt'];

function task(overrides: Partial<BackgroundTask>): BackgroundTask {
  return {
    agentId: 'root',
    args: {},
    createdAt: new Date('2026-09-15T00:00:00Z'),
    id: 'task-1',
    maxRetries: 0,
    retryCount: 0,
    status: 'completed',
    timeoutMs: 1000,
    toolCallId: 'delegate-1',
    toolName: 'agent-explore',
    ...overrides,
  } as BackgroundTask;
}

const ack = {
  type: 'text' as const,
  value:
    'Background task started. Task ID: task-1. The tool "agent-explore" is running in the background.',
};

function prompt(): Prompt {
  return [
    { content: [{ text: 'Report', type: 'text' }], role: 'user' },
    {
      content: [
        { input: {}, toolCallId: 'delegate-1', toolName: 'agent-explore', type: 'tool-call' },
        { input: {}, toolCallId: 'other', toolName: 'agent-explore', type: 'tool-call' },
      ],
      role: 'assistant',
    },
    {
      content: [
        {
          output: ack,
          providerOptions: { mastra: { modelOutput: ack } },
          toolCallId: 'delegate-1',
          toolName: 'agent-explore',
          type: 'tool-result',
        },
        { output: ack, toolCallId: 'other', toolName: 'agent-explore', type: 'tool-result' },
      ],
      role: 'tool',
    },
  ] as Prompt;
}

const args = (input: Prompt): ProcessLLMRequestArgs => ({ prompt: input }) as ProcessLLMRequestArgs;

describe('LateBackgroundResultsProcessor', () => {
  it("overlays a late task's saved outcome onto its acknowledgement, leaving other results alone", () => {
    const processor = new LateBackgroundResultsProcessor([
      task({ result: { text: 'CHILD_FINAL_EVIDENCE' } }),
    ]);
    const input = prompt();
    const rewritten = processor.processLLMRequest(args(input))?.prompt;
    if (!rewritten) {
      throw new Error('Expected a rewritten prompt');
    }
    const tool = rewritten[2];
    if (tool?.role !== 'tool') {
      throw new Error('Expected the tool message');
    }
    expect(tool.content[0]).toMatchObject({
      output: { type: 'json', value: { text: 'CHILD_FINAL_EVIDENCE' } },
      providerOptions: { mastra: { modelOutput: { type: 'json' } } },
    });
    expect(tool.content[1]).toMatchObject({ output: ack });
    // Untouched messages are the same objects; only the tool message is copied.
    expect(rewritten[0]).toBe(input[0]);
    expect(rewritten[1]).toBe(input[1]);
  });

  it('overlays a failed outcome as an error result', () => {
    const processor = new LateBackgroundResultsProcessor([
      task({ error: { message: 'boom' }, status: 'failed' }),
    ]);
    const tool = processor.processLLMRequest(args(prompt()))?.prompt?.[2];
    if (tool?.role !== 'tool') {
      throw new Error('Expected the tool message');
    }
    expect(tool.content[0]).toMatchObject({ output: { type: 'error-text', value: 'boom' } });
  });

  it('rewrites nothing when the prompt carries no late acknowledgement, and builds nothing for no late tasks', () => {
    const processor = new LateBackgroundResultsProcessor([task({ toolCallId: 'absent' })]);
    expect(processor.processLLMRequest(args(prompt()))).toBeUndefined();
    expect(createLateBackgroundResultsProcessor([])).toBeUndefined();
  });

  it('refuses an unfinished task: only a finished outcome can be presented', () => {
    expect(() => new LateBackgroundResultsProcessor([task({ status: 'running' })])).toThrow(
      'unfinished'
    );
  });
});

describe('recordLateOverlayWakeup', () => {
  it('records one late-overlay wakeup naming every late task, and nothing when none returned late', async () => {
    const wakeups: unknown[] = [];
    const runtime = {
      conversationBinding: {
        recordWakeup: async (record: unknown) => {
          wakeups.push(record);
        },
      },
    } as never;
    await recordLateOverlayWakeup(runtime, [
      task({ id: 't1', result: { text: 'done' } }),
      task({
        error: { message: 'boom' },
        id: 't2',
        status: 'failed',
        toolCallId: 'delegate-2',
        toolName: 'agent-analyze',
      }),
    ]);
    expect(wakeups).toEqual([
      {
        directive:
          'Late background results overlaid at the provider boundary: dispatch acknowledgements replaced by saved outcomes. No model-facing wakeup text was sent.',
        invocations: [
          { outcome: 'late', taskId: 't1', toolCallId: 'delegate-1', toolName: 'agent-explore' },
          { outcome: 'late', taskId: 't2', toolCallId: 'delegate-2', toolName: 'agent-analyze' },
        ],
        kind: 'late-overlay',
      },
    ]);
    // MUTATION: dropping the empty guard records a row for a resume with nothing late.
    await recordLateOverlayWakeup(runtime, []);
    expect(wakeups).toHaveLength(1);
  });
});
