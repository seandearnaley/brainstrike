/**
 * BST-1701 end to end: a dropped setting becomes a row on the turn.
 *
 * Drives the REAL `streamMastraAgent` -> real Mastra agent loop against a
 * scripted `LanguageModelV4`, so the notice is proven through the same seam
 * production uses. Integration lane, like every other spec here that runs the
 * real Mastra loop (`mastra-stall-recovery.integration.spec.ts`).
 *
 * This is the file that would have caught the wrong fix. Mastra 1.64 DROPS the
 * adapter's `stream-start` part and reports `step-start.payload.warnings` as
 * `[]` for every hosted provider, so a consumer written against the Mastra
 * chunk would pass its own unit tests and report nothing here.
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { StreamChunk } from '../types';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as LanguageModelV4 | undefined },
}));

vi.mock('../providers/provider-factory', async (importActual) => {
  const actual = await importActual<typeof import('../providers/provider-factory')>();
  return {
    ...actual,
    createProvider: vi.fn(() => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    }),
    getDefaultModel: () => 'gpt-5.6-terra',
  };
});

const { createProvider } = await import('../providers/provider-factory');
const { streamMastraAgent } = await import('../mastra/agent-streaming');
const { createMastraAgentRuntime } = await import('../mastra/agent-runtime');

/**
 * The v4 finish-reason shape: `{unified, raw}`, not a bare string. Spelled the
 * way the installed provider spec declares it so this fixture matches what a
 * real adapter hands the stream.
 */
const FINISH_STOP = { raw: undefined, unified: 'stop' } as const;
const FINISH_TOOL_CALLS = { raw: undefined, unified: 'tool-calls' } as const;

/** The v4 usage shape: both token counts are structured, not bare numbers. */
const USAGE = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
} as const;
const TOOL_ID = 'brainstrike_grepSearch';

function enqueue(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

/** A one-step answer whose `stream-start` carries `warnings`. */
function modelWarning(warnings: readonly unknown[]): LanguageModelV4 {
  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (_options: LanguageModelV4CallOptions) =>
      Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings } as unknown as LanguageModelV4StreamPart,
          { id: 'final', type: 'text-start' },
          { delta: 'ANSWER', id: 'final', type: 'text-delta' },
          { id: 'final', type: 'text-end' },
          { finishReason: FINISH_STOP, type: 'finish', usage: USAGE },
        ]),
      }),
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v4',
    supportedUrls: {},
  };
}

interface RunEventLike {
  detail?: string;
  kind: string;
  label: string;
  metadata?: Record<string, unknown>;
  status: string;
}

async function collectRunEvents(warnings: readonly unknown[]): Promise<{
  events: RunEventLike[];
  text: string;
}> {
  modelHolder.current = modelWarning(warnings);
  const iterator = await streamMastraAgent(
    [{ id: 'u1', parts: [{ text: 'hi', type: 'text' }], role: 'user' }],
    { runtime: { apiKey: 'test-key', modelSettings: { temperature: 0.7 }, provider: 'openai' } }
  );
  const events: RunEventLike[] = [];
  let text = '';
  for await (const chunk of iterator as AsyncIterable<StreamChunk>) {
    if (chunk.type === 'run-event') {
      events.push(chunk.event as RunEventLike);
    } else if (chunk.type === 'text-delta') {
      text += chunk.value;
    }
  }
  return { events, text };
}

describe('provider warnings on the turn (real Mastra loop)', () => {
  it.each(['inherited', 'pinned', 'different-model-pin', 'descriptor-parent'] as const)(
    'captures %s persona model warnings in the parent run sink',
    async (mode) => {
      vi.mocked(createProvider).mockClear();
      modelHolder.current = modelWarning([{ feature: 'temperature', type: 'unsupported' }]);
      const runtime = await createMastraAgentRuntime({
        ...(mode === 'descriptor-parent'
          ? {
              modelOverride: {
                apiKey: 'fixture',
                id: 'ollama/fixture',
                url: 'http://127.0.0.1:11434/v1',
              },
            }
          : {}),
        personas: [
          {
            allowedToolIds: ['brainstrike.grepSearch'],
            description: 'Explore the workspace',
            id: 'explore',
            instructions: 'Answer the question.',
            label: 'Explorer',
            maxSteps: 4,
            ...(mode === 'inherited'
              ? {}
              : {
                  model: {
                    modelId: mode === 'different-model-pin' ? 'gpt-5.6-sol' : 'gpt-5.6-terra',
                    provider: 'openai',
                  },
                }),
          },
        ],
        runtime: {
          apiKey: 'test-key',
          personaProviderApiKeys: { openai: 'test-key' },
          provider: mode === 'descriptor-parent' ? 'ollama' : 'openai',
        },
        tools: {
          'brainstrike.grepSearch': createTool({
            description: 'Search the workspace.',
            execute: async () => ({ matches: [] }),
            id: TOOL_ID,
            inputSchema: z.object({ pattern: z.string() }),
          }),
        },
      });
      try {
        const child = (await runtime.agent.listAgents())['explore'];
        expect(child).toBeInstanceOf(Agent);
        if (!(child instanceof Agent)) {
          throw new Error('Expected the production persona agent.');
        }
        const response = await child.stream('Find the answer.');
        for await (const _part of response.fullStream) {
          // Consume the real native agent stream so the model observer runs.
        }
        expect(await response.text).toBe('ANSWER');
        expect(runtime.providerCallWarnings.drain()).toEqual([
          {
            origin: {
              modelId: mode === 'different-model-pin' ? 'gpt-5.6-sol' : 'gpt-5.6-terra',
              provider: 'openai',
            },
            subject: 'temperature',
            type: 'unsupported',
          },
        ]);
        if (mode === 'descriptor-parent') {
          // Only the pin uses the factory: the supervisor kept its explicit descriptor.
          expect(createProvider).toHaveBeenCalledTimes(1);
          return;
        }
        const parent = await runtime.agent.stream('Answer without delegating.');
        for await (const _part of parent.fullStream) {
          // The same warning on the parent must share the per-run dedupe set.
        }
        expect(runtime.providerCallWarnings.drain()).toEqual(
          mode === 'different-model-pin'
            ? [
                {
                  origin: { modelId: 'gpt-5.6-terra', provider: 'openai' },
                  subject: 'temperature',
                  type: 'unsupported',
                },
              ]
            : []
        );
      } finally {
        await runtime.dispose();
      }
    }
  );
  it('surfaces a dropped sampling param as a visible row on an otherwise healthy turn', async () => {
    const { events, text } = await collectRunEvents([
      {
        details: 'temperature is not supported by claude-opus-5 and will be ignored',
        feature: 'temperature',
        type: 'unsupported',
      },
    ]);

    const notices = events.filter((event) => event.kind === 'provider.request.warned');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      detail:
        'openai/gpt-5.6-terra: temperature: temperature is not supported by claude-opus-5 and will be ignored',
      label: 'Provider ignored an unsupported setting',
      metadata: {
        feature: 'temperature',
        modelId: 'gpt-5.6-terra',
        provider: 'openai',
        warningType: 'unsupported',
      },
      status: 'failed',
    });

    // The turn itself is healthy - which is exactly why the row has to exist.
    const kinds = events.map((event) => event.kind);
    expect(text).toContain('ANSWER');
    expect(kinds).toContain('run.finished');
    expect(kinds).not.toContain('run.failed');
    // Ordered as a breadcrumb at the top of the turn: after the run opens,
    // ahead of the answer, and never after the finish chunk that stops the
    // consumer pulling.
    expect(kinds.indexOf('provider.request.warned')).toBeGreaterThan(kinds.indexOf('run.started'));
    expect(kinds.indexOf('provider.request.warned')).toBeLessThan(
      kinds.indexOf('run.step.finished')
    );
    expect(kinds.indexOf('provider.request.warned')).toBeLessThan(kinds.indexOf('run.finished'));
  });

  it('says nothing when the provider reported no warnings', async () => {
    const { events, text } = await collectRunEvents([]);

    expect(events.filter((event) => event.kind === 'provider.request.warned')).toEqual([]);
    expect(text).toContain('ANSWER');
    expect(events.map((event) => event.kind)).toContain('run.finished');
  });

  it('surfaces a non-unsupported warning type just the same', async () => {
    const { events } = await collectRunEvents([
      {
        message: 'maxTokens is deprecated, use maxOutputTokens',
        setting: 'maxTokens',
        type: 'deprecated',
      },
    ]);

    expect(events.filter((event) => event.kind === 'provider.request.warned')).toMatchObject([
      {
        detail: 'openai/gpt-5.6-terra: maxTokens: maxTokens is deprecated, use maxOutputTokens',
        label: 'Provider reported a deprecated setting',
        metadata: { feature: 'maxTokens', warningType: 'deprecated' },
        status: 'failed',
      },
    ]);
  });

  it('reports one row for a warning the provider repeats on every step', async () => {
    // A real TWO-STEP turn: the model calls a tool, then answers. Both model
    // calls open with the same `stream-start` warning, which is what a hosted
    // provider actually does - the rejection is a property of the request, so
    // it recurs on every step. The user must see it once.
    const warning = {
      details: 'temperature is not supported and will be ignored',
      feature: 'temperature',
      type: 'unsupported',
    };
    const promptsSeen: LanguageModelV4CallOptions[] = [];
    modelHolder.current = {
      doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
      doStream: (options: LanguageModelV4CallOptions) => {
        promptsSeen.push(options);
        const answered =
          Array.isArray(options.prompt) &&
          options.prompt.some((message) => message.role === 'tool');
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [warning] } as unknown as LanguageModelV4StreamPart,
            ...(answered
              ? ([
                  { id: 'final', type: 'text-start' },
                  { delta: 'ANSWER', id: 'final', type: 'text-delta' },
                  { id: 'final', type: 'text-end' },
                  { finishReason: FINISH_STOP, type: 'finish', usage: USAGE },
                ] as LanguageModelV4StreamPart[])
              : ([
                  {
                    input: JSON.stringify({ pattern: 'flag' }),
                    toolCallId: 'call-1',
                    toolName: TOOL_ID,
                    type: 'tool-call',
                  },
                  { finishReason: FINISH_TOOL_CALLS, type: 'finish', usage: USAGE },
                ] as unknown as LanguageModelV4StreamPart[])),
          ]),
        });
      },
      modelId: 'fake-model',
      provider: 'fake',
      specificationVersion: 'v4',
      supportedUrls: {},
    };

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
      {
        runtime: { apiKey: 'test-key', modelSettings: { temperature: 0.7 }, provider: 'openai' },
        tools: {
          'brainstrike.grepSearch': createTool({
            description: 'Search the workspace for a pattern.',
            execute: () => Promise.resolve({ matches: ['found'] }),
            id: TOOL_ID,
            inputSchema: z.object({ pattern: z.string() }),
            outputSchema: z.object({ matches: z.array(z.string()) }),
          }),
        },
      }
    );
    const kinds: string[] = [];
    for await (const chunk of iterator as AsyncIterable<StreamChunk>) {
      if (chunk.type === 'run-event') {
        kinds.push(chunk.event.kind);
      }
    }

    // The premise of the test: the provider really was asked twice.
    expect(promptsSeen).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'provider.request.warned')).toHaveLength(1);
  });
});
