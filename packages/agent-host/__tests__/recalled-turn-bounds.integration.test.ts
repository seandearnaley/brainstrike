/**
 * Semantic recall from other threads brings an earlier turn's question and
 * answer, never its whole tool transcript. A recall hit on one message of a
 * long delegated run once pulled that run's every step into a new thread, and
 * a handful of hits made a one-line prompt need ~950K tokens.
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { memoryVectorHost, RecordedVectorCalls } from './fixtures/memory-vector-host.js';

const PROMPT = 'Find the beaker bug.';

test('a turn reached only through recall brings its question and answer, not its tool calls', async () => {
  const vector = new RecordedVectorCalls();
  const host = await memoryVectorHost({ semanticScope: 'resource', toolTurn: true, vector });
  try {
    const thread = async () => (await host.core.startThread({ commandId: randomUUID() })).threadId;
    const earlier = await thread();
    await host.run(earlier, PROMPT);
    // Recall matches the earlier turn's answer, a step of that turn's run.
    const hit = vector.upserts
      .flatMap((upsert) => upsert.metadata ?? [])
      .find((metadata) => metadata['thread_id'] === earlier && metadata['role'] === 'assistant');
    if (!hit) {
      throw new Error('The earlier turn was never embedded');
    }
    vector.results = [{ id: String(hit['message_id']), metadata: hit, score: 1 }];

    await host.run(await thread(), PROMPT);
    const request = host.models.at(-1)?.doStreamCalls[0]?.prompt ?? [];
    const parts = request.flatMap((message) =>
      typeof message.content === 'string'
        ? []
        : (message.content as readonly { readonly type: string; readonly text?: string }[])
    );

    expect(
      request.filter(
        (message) =>
          message.role === 'user' &&
          message.content.some((part) => part.type === 'text' && part.text.includes(PROMPT))
      )
    ).toHaveLength(2);
    // The earlier answer arrives with its question; its tool exchange does not.
    expect(parts).toContainEqual(expect.objectContaining({ text: 'Host run completed.' }));
    expect(
      parts.filter((part) => part.type === 'tool-call' || part.type === 'tool-result')
    ).toEqual([]);
  } finally {
    await host.close();
  }
});
