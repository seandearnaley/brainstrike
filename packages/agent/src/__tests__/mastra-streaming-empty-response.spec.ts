/**
 * An EMPTY model response must never complete a turn silently.
 *
 * Field case (2026-08-23, stealth/ox-alpha): OpenRouter's anonymous route
 * started returning HTTP 200 streams containing ONE instant model step with
 * zero usage, no text, no reasoning, no tool calls, and a clean `finish` —
 * five consecutive runs. The mapper translated that to `run.finished /
 * completed` plus an empty assistant bubble, which is a silent fallback:
 * the user sees "success" and nothing else.
 *
 * The contract under test: a terminal `finish` on a turn whose model
 * contributed NOTHING (no non-empty text delta, no reasoning delta, no tool
 * lifecycle part, across every attempt of the turn) ends the ATTEMPT, not the
 * turn — it rides the BST-1409 stall-recovery rails (retry up to the stall
 * attempt budget, then the honest visible-failure triple). A transient
 * provider hiccup self-heals into a real answer; a dead route surfaces as a
 * `run.failed` naming the real cause instead of an empty bubble.
 */

import { describe, expect, it, vi } from 'vitest';

import { streamMastraAgent } from '../mastra/agent-streaming';
import {
  agentInstances,
  expectLeadingContextBreakdown,
  findRunEventChunks,
  resetMastraStreamHarness,
  setMockMessageList,
  setMockStreamParts,
  setMockStreamPartsForCall,
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

/** The ox-alpha shape: a clean finish with nothing before it and no usage. */
const EMPTY_RESPONSE_PARTS = [
  { finishReason: 'stop', type: 'finish', usage: { completionTokens: 0, promptTokens: 0 } },
];

async function collectChunks(): Promise<unknown[]> {
  const iterator = await streamMastraAgent(
    [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
    { runtime: { apiKey: 'test-key', provider: 'openai' } }
  );
  const chunks: unknown[] = [];
  for await (const chunk of iterator) {
    chunks.push(chunk);
  }
  return expectLeadingContextBreakdown(chunks);
}

function finishChunks(chunks: unknown[]): Array<{ finishReason?: string }> {
  return chunks.filter(
    (chunk): chunk is { finishReason?: string } =>
      typeof chunk === 'object' &&
      chunk !== null &&
      (chunk as { type?: string }).type === 'message-finish'
  );
}

describe('empty model response recovery', () => {
  /** Recovery corroboration reads the attempt's produced messages; give the
   * mock stream a readable, EMPTY message list (real Mastra always attaches
   * one) so an empty attempt is retryable rather than refused as unreadable. */
  const emptyMessageList = () =>
    setMockMessageList({ drainUnsavedMessages: () => [], get: { response: { db: () => [] } } });

  it('retries an empty first response and completes with the second attempt', async () => {
    resetMastraStreamHarness();
    emptyMessageList();
    setMockStreamPartsForCall(1, EMPTY_RESPONSE_PARTS);
    setMockStreamPartsForCall(2, [
      { textDelta: 'recovered answer', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 3, promptTokens: 7 } },
    ]);

    const chunks = await collectChunks();

    // The attempt fault is durable and named: the run.stalled row carries the
    // empty-response code, and run.resumed records the recovery.
    const stalled = findRunEventChunks(chunks, 'run.stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.event.metadata).toMatchObject({ code: 'empty_model_response' });
    const resumed = findRunEventChunks(chunks, 'run.resumed');
    expect(resumed).toHaveLength(1);
    // `run.stalled`/`run.resumed` are the ONLY durable record of a recovered
    // attempt, so the pair must name the fault that actually happened —
    // "Continuing after a stall" here would describe a stall that never
    // occurred, in the exact text a debug bundle shows.
    expect(resumed[0]?.event.label).toBe('Continuing after an empty response');

    // The turn ends as a SUCCESS with the recovered text.
    expect(chunks).toContainEqual({ type: 'text-delta', value: 'recovered answer' });
    expect(findRunEventChunks(chunks, 'run.finished')).toHaveLength(1);
    expect(findRunEventChunks(chunks, 'run.failed')).toHaveLength(0);
    expect(finishChunks(chunks).at(-1)?.finishReason).toBe('stop');

    expect(agentInstances[0]?.streamCalls).toHaveLength(2);
  });

  it('fails visibly — never an empty completed bubble — when every attempt is empty', async () => {
    resetMastraStreamHarness();
    emptyMessageList();
    // Global parts: EVERY attempt replays the empty response.
    setMockStreamParts(EMPTY_RESPONSE_PARTS);

    const chunks = await collectChunks();

    // Attempt budget spent: attempt 1 recoverable, attempt 2 refused.
    const stalled = findRunEventChunks(chunks, 'run.stalled');
    expect(stalled).toHaveLength(2);
    expect(stalled[1]?.event.metadata).toMatchObject({ refusal: 'budget-exhausted' });

    // The honest terminal triple: visible text naming the fault, run.failed,
    // error finish. No run.finished, no silent empty success.
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'text-delta',
        value: expect.stringMatching(/empty response/i),
      })
    );
    expect(findRunEventChunks(chunks, 'run.failed')).toHaveLength(1);
    expect(findRunEventChunks(chunks, 'run.finished')).toHaveLength(0);
    expect(finishChunks(chunks).at(-1)?.finishReason).toBe('error');
  });

  it('does not treat a reasoning-only response as empty', async () => {
    resetMastraStreamHarness();
    emptyMessageList();
    // Reasoning is model output the user can see; a turn of pure thinking may
    // be odd, but it is not an EMPTY stream and must not be retried as one.
    setMockStreamParts([
      { delta: 'thinking it through', type: 'reasoning-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 5, promptTokens: 7 } },
    ]);

    const chunks = await collectChunks();

    expect(findRunEventChunks(chunks, 'run.stalled')).toHaveLength(0);
    expect(findRunEventChunks(chunks, 'run.finished')).toHaveLength(1);
    expect(agentInstances[0]?.streamCalls).toHaveLength(1);
  });

  it("carries the empty attempt's spend into the recovered turn's ledger", async () => {
    resetMastraStreamHarness();
    emptyMessageList();
    // BILLING IS PER TURN: a recovered turn really did spend the empty
    // attempt's tokens. An empty attempt reports its usage on the TERMINAL
    // finish (there is no step-finish to carry it), so absorbing that usage
    // before throwing is the only way the ledger stays honest — otherwise the
    // user is billed for a prompt the run ledger never records.
    setMockStreamPartsForCall(1, [
      {
        finishReason: 'stop',
        providerMetadata: { openrouter: { usage: { cost: 0.002 } } },
        type: 'finish',
        usage: { completionTokens: 0, promptTokens: 12_000 },
      },
    ]);
    setMockStreamPartsForCall(2, [
      { textDelta: 'recovered', type: 'text-delta' },
      {
        finishReason: 'stop',
        providerMetadata: { openrouter: { usage: { cost: 0.001 } } },
        type: 'finish',
        usage: { completionTokens: 5, promptTokens: 7 },
      },
    ]);

    const chunks = await collectChunks();

    const finish = finishChunks(chunks).at(-1) as
      | { billedCostUsd?: number; usage?: { completionTokens: number; promptTokens: number } }
      | undefined;
    expect(finish?.usage?.promptTokens).toBe(12_007);
    expect(finish?.usage?.completionTokens).toBe(5);
  });

  it('does not treat a TOOL-ONLY turn as an empty response', async () => {
    resetMastraStreamHarness();
    emptyMessageList();
    // A turn whose model output was a tool call carries no text or reasoning
    // delta at all. Tool parts are model contribution; re-streaming such a
    // turn would re-execute its tools and then fail a real answer as "empty".
    setMockStreamParts([
      {
        payload: { args: {}, toolCallId: 'call-1', toolName: 'read_file' },
        type: 'tool-call',
      },
      {
        payload: { result: { text: 'ok' }, toolCallId: 'call-1', toolName: 'read_file' },
        type: 'tool-result',
      },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 4, promptTokens: 9 } },
    ]);

    const chunks = await collectChunks();

    expect(findRunEventChunks(chunks, 'run.stalled')).toHaveLength(0);
    expect(findRunEventChunks(chunks, 'run.finished')).toHaveLength(1);
    expect(agentInstances[0]?.streamCalls).toHaveLength(1);
  });

  it('treats a stream of only WHITESPACE text deltas as an empty response', async () => {
    resetMastraStreamHarness();
    emptyMessageList();
    // A bubble containing only spaces/newlines is visually empty — the exact
    // outcome this guard exists to prevent — so whitespace is not
    // contribution. The deltas still STREAM (formatting whitespace between
    // real tokens is meaningful); only the contribution flag is withheld.
    setMockStreamPartsForCall(1, [
      { textDelta: ' ', type: 'text-delta' },
      { textDelta: '\n\n', type: 'text-delta' },
      ...EMPTY_RESPONSE_PARTS,
    ]);
    setMockStreamPartsForCall(2, [
      { textDelta: 'real answer', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 2, promptTokens: 7 } },
    ]);

    const chunks = await collectChunks();

    expect(findRunEventChunks(chunks, 'run.resumed')).toHaveLength(1);
    expect(chunks).toContainEqual({ type: 'text-delta', value: 'real answer' });
    expect(findRunEventChunks(chunks, 'run.finished')).toHaveLength(1);
  });

  it('counts whitespace-adjacent text as contribution once a real character arrives', async () => {
    resetMastraStreamHarness();
    emptyMessageList();
    // Falsifies the whitespace rule in the other direction: a response that
    // OPENS with whitespace is a normal answer, not an empty one, and the
    // leading whitespace must still reach the renderer.
    setMockStreamParts([
      { textDelta: '\n', type: 'text-delta' },
      { textDelta: 'answer after a leading newline', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 4, promptTokens: 7 } },
    ]);

    const chunks = await collectChunks();

    expect(chunks).toContainEqual({ type: 'text-delta', value: '\n' });
    expect(findRunEventChunks(chunks, 'run.stalled')).toHaveLength(0);
    expect(findRunEventChunks(chunks, 'run.finished')).toHaveLength(1);
    expect(agentInstances[0]?.streamCalls).toHaveLength(1);
  });

  it('treats a stream of only EMPTY text deltas as an empty response', async () => {
    resetMastraStreamHarness();
    emptyMessageList();
    // Zero-length deltas are dropped by the mapper and paint nothing; they must
    // not count as model contribution.
    setMockStreamPartsForCall(1, [{ textDelta: '', type: 'text-delta' }, ...EMPTY_RESPONSE_PARTS]);
    setMockStreamPartsForCall(2, [
      { textDelta: 'second try', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 2, promptTokens: 7 } },
    ]);

    const chunks = await collectChunks();

    expect(findRunEventChunks(chunks, 'run.resumed')).toHaveLength(1);
    expect(chunks).toContainEqual({ type: 'text-delta', value: 'second try' });
    expect(findRunEventChunks(chunks, 'run.finished')).toHaveLength(1);
  });
});
