import type { createAnthropic } from '@ai-sdk/anthropic';
import { expect, it } from 'vitest';
import { createProvider } from '../providers/provider-factory';

// Real installed adapter + production factory, keyless HTTP fixture (not a live smoke).
it.each(['low', 'medium', 'high', 'xhigh', 'max', undefined] as const)(
  'serializes Opus 5 structured output, tools and thinking configuration %s',
  async (effort) => {
    const bodies: unknown[] = [];
    const model = createProvider(
      'anthropic',
      {
        apiKey: 'fixture-key',
        fetch: async (_input, init): Promise<Response> => {
          bodies.push(JSON.parse(String(init?.body)));
          return Response.json({
            content: [{ text: '{"ok":true}', type: 'text' }],
            id: 'msg_opus_5_fixture',
            model: 'claude-opus-5',
            role: 'assistant',
            stop_reason: 'end_turn',
            stop_sequence: null,
            type: 'message',
            usage: { input_tokens: 10, output_tokens: 4 },
          });
        },
        kind: 'custom_fetch',
      },
      'claude-opus-5'
    ) as ReturnType<ReturnType<typeof createAnthropic>>;
    const schema = {
      additionalProperties: false,
      properties: { ok: { type: 'boolean' as const } },
      required: ['ok'],
      type: 'object' as const,
    };
    const result = await model.doGenerate({
      maxOutputTokens: 128_000,
      prompt: [{ content: [{ text: 'Return ok.', type: 'text' }], role: 'user' }],
      providerOptions: {
        anthropic: effort
          ? { effort, thinking: { type: 'adaptive' } }
          : { thinking: { type: 'disabled' } },
      },
      responseFormat: { schema, type: 'json' },
      tools: [{ inputSchema: schema, name: 'check', type: 'function' }],
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      max_tokens: 128_000,
      model: 'claude-opus-5',
      output_config: { ...(effort ? { effort } : {}), format: { schema, type: 'json_schema' } },
      thinking: { type: effort ? 'adaptive' : 'disabled' },
      tools: [{ input_schema: schema, name: 'check' }],
    });
    expect(result.content).toContainEqual({ text: '{"ok":true}', type: 'text' });
  }
);
