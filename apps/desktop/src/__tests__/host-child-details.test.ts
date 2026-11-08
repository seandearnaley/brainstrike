import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { expect, test } from 'vitest';
import { HostChildDetailsFold } from '../renderer/host-child-details';

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });
const row = (seq: number, event: Record<string, unknown>): HostLogRow =>
  ({ event, seq, threadId: 'child', ts: seq }) as unknown as HostLogRow;

const origin = row(1, {
  origin: {
    background: true,
    depth: 1,
    parentRunId: 'parent-run',
    parentThreadId: 'root',
    persona: 'review',
    profile: { label: 'Reviewer', mode: 'read-only' },
    toolCallId: 'call-1',
    turnId: 'parent-run',
  },
  type: 'thread.started',
});
const started = (seq: number, runId: string, modelId: string) =>
  row(seq, { modelId, prompt: 'Review.', runId, type: 'run.started' });
const step = (seq: number, runId: string, tokens: ReturnType<typeof usage>) =>
  row(seq, { messages: [], model: {}, runId, stepNumber: seq, type: 'model.step', usage: tokens });

test("a child's toolbar states its latest run's model with that run's own steps and tokens", () => {
  const fold = new HostChildDetailsFold();
  const delegated = [
    origin,
    started(2, 'delegated', 'openrouter::anthropic/claude-opus-5.5'),
    step(3, 'delegated', usage(1000, 400)),
    step(4, 'delegated', usage(1200, 300)),
    row(5, { outcome: 'completed', runId: 'delegated', type: 'run.finished' }),
  ];
  expect(fold.apply(delegated)).toMatchObject({
    modelId: 'openrouter::anthropic/claude-opus-5.5',
    steps: 2,
    usage: usage(2200, 700),
  });

  // A person's follow-up runs on another model: its figures are its own.
  const followed = [
    ...delegated,
    started(6, 'follow-up', 'openai::gpt-6-sol'),
    step(7, 'follow-up', usage(50, 20)),
  ];
  expect(fold.apply(followed)).toMatchObject({
    modelId: 'openai::gpt-6-sol',
    steps: 1,
    usage: usage(50, 20),
  });
});
