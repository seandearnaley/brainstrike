/**
 * BST-2310: workers that each delegate several workers onward, wider than the
 * turn's work queue, still finish when every provider reply streams in many
 * deltas. Delegation waits hold no permit (docs/agents/assistant-subagents.md).
 */
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import {
  type Chunk,
  childThreads,
  finished,
  rowsUntil,
  setupChildRunHost,
  toolNames,
  userTexts,
  worker,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

/** A reply that streams the way providers do: deltas spaced in time, then any tool calls. */
function streamed(
  words: readonly string[],
  calls: readonly { readonly input: unknown; readonly toolName: string }[] = []
) {
  let serial = 0;
  return {
    stream: new ReadableStream<Chunk>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ id: 'text-1', type: 'text-start' });
        for (const delta of words) {
          await new Promise((resolve) => setTimeout(resolve, 3));
          controller.enqueue({ delta, id: 'text-1', type: 'text-delta' });
        }
        controller.enqueue({ id: 'text-1', type: 'text-end' });
        for (const call of calls) {
          controller.enqueue({
            input: JSON.stringify(call.input),
            toolCallId: `call-${Math.random().toString(36).slice(2)}-${++serial}`,
            toolName: call.toolName,
            type: 'tool-call',
          });
        }
        controller.enqueue({
          finishReason:
            calls.length > 0
              ? { raw: 'tool_calls', unified: 'tool-calls' }
              : { raw: 'stop', unified: 'stop' },
          type: 'finish',
          usage,
        });
        controller.close();
      },
    }),
  };
}

const delegate = (prompt: string) => ({
  input: { _background: { disposition: 'awaited', enabled: true }, prompt },
  toolName: 'agent-worker',
});
const nested = (prompt: string) => ({ input: { prompt }, toolName: 'agent-worker' });
const WORDS = ['Working ', 'through ', 'the ', 'area ', 'now.'];

test('nested parallel delegation wider than the work queue finishes with streamed replies', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const task = userTexts(call).join('\n');
      const answered = call.prompt.some((message) => message.role === 'tool');
      if (task.includes('LEAF_')) {
        // A leaf reads twice in parallel, as a worker reading two files does.
        return answered
          ? streamed(WORDS)
          : streamed(
              WORDS,
              [0, 1].map(() => ({ input: { path: 'notes.md' }, toolName: 'read_file' }))
            );
      }
      if (task.includes('BRANCH_')) {
        const branch = /BRANCH_(\d)/u.exec(task)?.[1] ?? '0';
        return answered
          ? streamed(['Branch ', 'merged.'])
          : streamed(
              WORDS,
              [0, 1, 2].map((leaf) => nested(`LEAF_${branch}_${leaf}: report.`))
            );
      }
      if (!toolNames(call).includes('agent-worker') || answered) {
        return streamed(['All ', 'branches ', 'done.']);
      }
      return streamed(
        WORDS,
        [0, 1, 2].map((branch) => delegate(`BRANCH_${branch}: split and delegate.`))
      );
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    personas: [worker],
    policy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, read: 'allow' as const },
      yolo: false,
    }),
    settings: { maxConcurrentWork: 2 },
  });
  const rootRunId = await harness.start('Fan out.');
  await rowsUntil(harness, harness.threadId, finished(rootRunId), 20_000);
  const children = await childThreads(harness);
  expect(children).toHaveLength(12);
  for (const child of children) {
    const rows = await harness.core().read(child, 0);
    expect(rows.filter((row) => row.event.type === 'run.finished').map((row) => row.event)).toEqual(
      [expect.objectContaining({ outcome: 'completed' })]
    );
  }
});
