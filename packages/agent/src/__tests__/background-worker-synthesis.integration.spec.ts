import { expect, it } from 'vitest';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

it.each([
  { reported: 512, reservation: 2048 },
  { reported: 1999, reservation: 1024 },
])(
  'a cut synthesis returns partial findings to the root with $reported tokens against $reservation reserved',
  async ({ reservation, reported }) => {
    // GLM pack 2026-09-15: three of four Explorers exhausted 16/16 steps and the
    // fourth's 512-token synthesis finished with `length`, which the terminal
    // mapper turned into run.failed and a "failed; do not retry" delegation. A
    // cut summary is partial findings: the child COMPLETES (truncated), the root
    // reads the text plus a truncation note, and the child tab records why.
    const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
      budget: {
        maxSteps: 4,
        reportedSynthesisTokens: reported,
        synthesisOutputTokens: reservation,
      },
    });
    const { backing, runtime, runtimeData, release, database, model, effect } = fixture;
    release.resolve();
    try {
      const chunks: StreamChunk[] = [];
      for await (const chunk of await createStreamIteratorFromRuntime({
        memory: backing.memory,
        messages: [
          { id: 'exhaust', parts: [{ text: 'Survey everything', type: 'text' }], role: 'user' },
        ],
        runtime,
        runtimeData,
      })) {
        chunks.push(chunk);
      }
      // Three working steps, then the reserved synthesis (steps 4/4).
      expect(effect).toHaveBeenCalledTimes(3);
      const synthesisCall = model.prompts.find((prompt) => prompt.maxOutputTokens === reservation);
      expect(synthesisCall).toBeDefined();
      expect(synthesisCall?.tools ?? []).toEqual([]);
      // No failure anywhere: not on the root, not on the child.
      const failed = chunks.filter(
        (chunk) =>
          (chunk.type === 'run-event' && chunk.event.kind === 'run.failed') ||
          (chunk.type === 'delegated-conversation-chunk' &&
            chunk.chunk.type === 'run-event' &&
            chunk.chunk.event.kind === 'run.failed')
      );
      expect(failed, JSON.stringify(failed)).toEqual([]);
      const childEvents = chunks.flatMap((chunk) =>
        chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'run-event'
          ? [chunk.chunk.event]
          : []
      );
      expect(childEvents).toContainEqual(
        expect.objectContaining({
          kind: 'delegation.budget.exhausted',
          metadata: expect.objectContaining({
            cap: 'steps',
            limit: 4,
            synthesisForced: true,
            truncated: true,
            used: 3,
          }),
          status: 'info',
        })
      );
      expect(childEvents).toContainEqual(
        expect.objectContaining({
          kind: 'run.finished',
          metadata: expect.objectContaining({ finishReason: 'length', outcome: 'truncated' }),
        })
      );
      const subagentTerminal = chunks.flatMap((chunk) =>
        chunk.type === 'run-event' && chunk.event.kind.startsWith('subagent.f') ? [chunk.event] : []
      );
      expect(subagentTerminal).toEqual([
        expect.objectContaining({
          kind: 'subagent.finished',
          metadata: expect.objectContaining({ outcome: 'truncated' }),
        }),
      ]);
      // The root's next model call sees the partial findings AND the note.
      const parentPrompts = model.prompts.filter((prompt) =>
        prompt.tools?.some((tool) => tool.name === 'agent-explore')
      );
      const last = JSON.stringify(parentPrompts.at(-1)?.prompt);
      expect(last).toContain('PARTIAL_CHILD_FINDINGS');
      expect(last).toContain('[Truncated summary]');
      if (reported > reservation) {
        expect(last).toContain(
          `${reported} total output tokens, exceeding the ${reservation}-token reservation`
        );
        expect(last).toContain(
          'All reported tokens remain charged; no further child work is allowed.'
        );
      }
      expect(last).not.toContain('do not retry it');
      expect(JSON.stringify(chunks)).toContain('PARENT_FINAL_OUTCOME');
    } finally {
      release.resolve();
      await runtime.dispose();
      await database.close();
    }
  }
);
