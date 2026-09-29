/**
 * Per-step `finishReason` (debug pack, 2026-09-15): every `run.step.finished`
 * row names why THAT step ended, read from the Mastra runtime chunk shape
 * (`payload.stepResult.reason`). The reason belongs to the step row only; the
 * run-level rows keep their own terminal semantics.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { streamMastraAgent } from '../mastra/agent-streaming';
import {
  findRunEventChunks,
  resetMastraStreamHarness,
  setMockStreamParts,
} from './fixtures/mastra-stream-harness';

vi.mock(
  '@ai-sdk/openai',
  async () => (await import('./fixtures/mastra-stream-harness')).openAiSdkMock
);

vi.mock(
  '@ai-sdk/anthropic',
  async () => (await import('./fixtures/mastra-stream-harness')).anthropicSdkMock
);

vi.mock(
  '@ai-sdk/google',
  async () => (await import('./fixtures/mastra-stream-harness')).googleSdkMock
);

vi.mock(
  '@mastra/core/agent',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraAgentModuleMock
);

vi.mock(
  '@mastra/core/mastra',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraCoreModuleMock
);

vi.mock(
  '../mcp/explicit-stdio-client',
  async () => (await import('./fixtures/mastra-stream-harness')).explicitStdioMcpClientModuleMock
);

function stepFinish(reason: string, inputTokens: number, outputTokens: number) {
  return {
    payload: {
      output: { usage: { inputTokens, outputTokens } },
      stepResult: { isContinued: reason === 'tool-calls', reason },
    },
    type: 'step-finish',
  };
}

const TWO_STEP_TURN = [
  { type: 'start' },
  { type: 'step-start' },
  { payload: { id: 'text-1', text: 'looking' }, type: 'text-delta' },
  stepFinish('tool-calls', 10, 5),
  { type: 'step-start' },
  { payload: { id: 'text-2', text: 'done' }, type: 'text-delta' },
  stepFinish('stop', 20, 7),
  {
    payload: {
      output: { usage: { inputTokens: 30, outputTokens: 12 } },
      stepResult: { isContinued: false, reason: 'stop' },
    },
    type: 'finish',
  },
];

async function streamTurn(steering?: { stopRequested: () => boolean }): Promise<unknown[]> {
  setMockStreamParts(TWO_STEP_TURN);
  const iterator = await streamMastraAgent(
    [{ id: 'user-steps', parts: [{ text: 'work', type: 'text' }], role: 'user' }],
    { runtime: { apiKey: 'test-key', provider: 'openai', ...(steering ? { steering } : {}) } }
  );
  const chunks: unknown[] = [];
  for await (const chunk of iterator) {
    chunks.push(chunk);
  }
  return chunks;
}

function finishReasons(chunks: readonly unknown[], kind: string): unknown[] {
  return findRunEventChunks(chunks, kind).map((chunk) => chunk.event.metadata?.['finishReason']);
}

describe('per-step finishReason on run.step.finished', () => {
  beforeEach(() => {
    resetMastraStreamHarness();
  });

  it('names why each step ended, while run.started and run.step.started carry none', async () => {
    const chunks = await streamTurn();

    expect(finishReasons(chunks, 'run.step.finished')).toEqual(['tool-calls', 'stop']);
    expect(finishReasons(chunks, 'run.started')).toEqual([undefined]);
    expect(finishReasons(chunks, 'run.step.started')).toEqual([undefined, undefined]);
    expect(finishReasons(chunks, 'run.finished')).toEqual(['stop']);
  });

  it('keeps the step reason off a steered run.finished, whose finish chunk reports stop', async () => {
    const chunks = await streamTurn({ stopRequested: () => true });

    expect(finishReasons(chunks, 'run.step.finished')).toEqual(['tool-calls']);
    expect(findRunEventChunks(chunks, 'run.steered')).toHaveLength(1);
    expect(finishReasons(chunks, 'run.finished')).toEqual([undefined]);
  });
});
