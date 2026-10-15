import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * End-to-end over the SERVER half of a Hosted Web turn (ADR-0022): the shared
 * decision core, the allow-list, the direct `streamText` adapter, the
 * DataStreamMapper and the wire encoding — everything except the provider,
 * which is scripted.
 *
 * This is the stream-shape parity proof. The Playwright e2e intercepts the
 * route at the network layer and so exercises the UI against canned frames;
 * only this test runs the bytes the route will really produce.
 */
const scriptedParts: unknown[] = [];

vi.mock('@brainstrike/agent/hosted-web', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent/hosted-web')>(
    '@brainstrike/agent/hosted-web'
  );
  return {
    ...actual,
    createProvider: vi.fn(() => ({ configuration: 'scripted' })),
    materializeHostProviderModel: vi.fn(
      () =>
        new MockLanguageModelV4({
          doStream: async () => ({
            stream: simulateReadableStream({
              chunkDelayInMs: null,
              chunks: scriptedParts as never,
              initialDelayInMs: null,
            }),
          }),
        })
    ),
  };
});

vi.mock('../assistant-config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../assistant-config.js')>('../assistant-config.js');
  return {
    ...actual,
    resolveAssistantProviderConfig: vi.fn((provider = 'openai') =>
      provider === 'openai'
        ? { apiKey: 'test-key', enabled: true, provider, source: 'OPENAI_API_KEY' }
        : { disabledReason: 'missing_api_key', enabled: false, provider }
    ),
  };
});

import { createStatelessAssistantDataStreamResponse } from '@brainstrike/agent/hosted-web';
import { runWebAssistantPost } from '../web-assistant-post.js';

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 12, total: 12 },
  outputTokens: { reasoning: 0, text: 4, total: 4 },
};

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
} as unknown as Parameters<typeof runWebAssistantPost>[0]['logger'];

function body(text: string): string {
  return JSON.stringify({
    data: { provider: 'openai' },
    messages: [{ id: 'u1', parts: [{ text, type: 'text' }], role: 'user' }],
  });
}

/** Decode the `<code>:<json>` frames the data stream writes. */
function frames(wire: string): { code: string; value: unknown }[] {
  return wire
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(':');
      return { code: line.slice(0, separator), value: JSON.parse(line.slice(separator + 1)) };
    });
}

async function runTurn(text: string): Promise<{ code: string; value: unknown }[]> {
  const outcome = await runWebAssistantPost({ bodyText: body(text), logger });
  if (outcome.kind !== 'stream') {
    throw new Error(`expected a stream, got ${JSON.stringify(outcome)}`);
  }
  const response = createStatelessAssistantDataStreamResponse(outcome.stream);
  return frames(await response.text());
}

describe('Hosted Web turn over the real route core', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scriptedParts.length = 0;
  });

  it('streams the model text to the wire and closes with a finish frame', async () => {
    scriptedParts.push(
      { type: 'stream-start', warnings: [] },
      { id: 't1', type: 'text-start' },
      { delta: 'Hello ', id: 't1', type: 'text-delta' },
      { delta: 'world', id: 't1', type: 'text-delta' },
      { id: 't1', type: 'text-end' },
      { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage }
    );

    const decoded = await runTurn('hi');

    expect(decoded.filter((frame) => frame.code === '0').map((frame) => frame.value)).toEqual([
      'Hello ',
      'world',
    ]);
    // `d` is the finish-message frame; the run must never reach the mapper's
    // missing-finish error path.
    expect(decoded.at(-1)?.code).toBe('d');
    expect(decoded.some((frame) => frame.code === '3')).toBe(false);
    expect(decoded.at(-1)?.value).toMatchObject({ finishReason: 'stop' });
  });

  it('reports a provider failure as an error frame rather than a silent stop', async () => {
    scriptedParts.push(
      { type: 'stream-start', warnings: [] },
      { error: new Error('upstream refused'), type: 'error' }
    );

    const decoded = await runTurn('hi');

    // No fallback: the turn fails visibly on the wire.
    expect(decoded.some((frame) => frame.code === '3')).toBe(true);
  });

  it('still refuses a tool approval action before any provider call', async () => {
    const outcome = await runWebAssistantPost({
      bodyText: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ id: 'u1', parts: [{ text: 'hi', type: 'text' }], role: 'user' }],
        runConfig: {
          custom: {
            brainstrikeToolApproval: {
              action: 'approve',
              runId: 'run-1',
              toolCallId: 'call-1',
            },
          },
        },
      }),
      logger,
    });

    expect(outcome).toMatchObject({ kind: 'rejection', status: 409 });
  });

  it('still rejects a runtime field the allow-list does not admit', async () => {
    const outcome = await runWebAssistantPost({
      bodyText: JSON.stringify({
        data: { mastraTools: { anything: true }, provider: 'openai' },
        messages: [{ id: 'u1', parts: [{ text: 'hi', type: 'text' }], role: 'user' }],
      }),
      logger,
    });

    expect(outcome).toMatchObject({ kind: 'rejection', status: 400 });
  });
});
