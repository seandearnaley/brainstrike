import type { createAnthropic } from '@ai-sdk/anthropic';
import { expect, it } from 'vitest';
import { createProvider } from '../providers/provider-factory';

// BST-1804: at Auto effort app-shell sends always-on Claude rows adaptive
// thinking with a `display` and NO effort. Real installed adapter + production
// factory, keyless HTTP fixture: pins that the SDK forwards `display` without
// an effort, adds no `output_config`, and attaches no beta for the GA values.
it.each(['summarized', 'omitted'] as const)(
  'forwards adaptive thinking display %s with no effort for Opus 5.5',
  async (display) => {
    const requests: { body: Record<string, unknown>; headers: Headers }[] = [];
    const model = createProvider(
      'anthropic',
      {
        apiKey: 'fixture-key',
        fetch: async (_input, init): Promise<Response> => {
          requests.push({
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
            headers: new Headers(init?.headers),
          });
          return Response.json({
            content: [{ text: 'ok', type: 'text' }],
            id: 'msg_opus_5_5_fixture',
            model: 'claude-opus-5-5',
            role: 'assistant',
            stop_reason: 'end_turn',
            stop_sequence: null,
            type: 'message',
            usage: { input_tokens: 10, output_tokens: 1 },
          });
        },
        kind: 'custom_fetch',
      },
      'claude-opus-5-5'
    ) as ReturnType<ReturnType<typeof createAnthropic>>;
    await model.doGenerate({
      maxOutputTokens: 64_000,
      prompt: [{ content: [{ text: 'Say ok.', type: 'text' }], role: 'user' }],
      providerOptions: { anthropic: { thinking: { display, type: 'adaptive' } } },
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.body['thinking']).toEqual({ display, type: 'adaptive' });
    expect(request?.body).not.toHaveProperty('output_config');
    expect(request?.headers.get('anthropic-beta') ?? '').not.toContain('thinking-display');
  }
);
