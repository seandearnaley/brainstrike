/**
 * Sign in with ChatGPT factory case (ADR-0038): `createProvider('chatgpt')`
 * sends the public Responses API a request a ChatGPT plan accepts, with the
 * token the host's closure answers for that request.
 */
import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MastraAgentError } from '../mastra-boundary/mastra-agent-error';
import { classifyChatGptPlanError } from '../providers/chatgpt-plan-errors';
import { createProvider } from '../providers/provider-factory';

interface SentRequest {
  readonly authorization: string | null;
  readonly body: Record<string, unknown>;
  readonly url: string;
}

interface StreamingModel {
  doGenerate(options: unknown): Promise<{
    content: readonly Record<string, unknown>[];
    finishReason: { unified: string };
    usage: { inputTokens: { total?: number }; outputTokens: { total?: number } };
  }>;
  doStream(options: unknown): Promise<{ stream: ReadableStream<Record<string, unknown>> }>;
}

const USAGE_LIMIT = {
  code: 'subscription_sharing_usage_limit_exceeded',
  message: 'Rate limit exceeded',
};

function serverSentEvents(events: readonly unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
    status: 200,
  });
}

const COMPLETED = [
  {
    response: { created_at: 1, id: 'resp_1', model: 'gpt-6.1-sol', service_tier: null },
    type: 'response.created',
  },
  { item: { id: 'msg_1', type: 'message' }, output_index: 0, type: 'response.output_item.added' },
  { delta: 'Hello', item_id: 'msg_1', type: 'response.output_text.delta' },
  { item: { id: 'msg_1', type: 'message' }, output_index: 0, type: 'response.output_item.done' },
  {
    response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 } },
    type: 'response.completed',
  },
];

/** OpenAI, answering each request with the next reply. */
function stubOpenAi(...replies: readonly (() => Response)[]): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({
      authorization: request.headers.get('authorization'),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      url: request.url,
    });
    const reply = replies[sent.length - 1] ?? replies.at(-1);
    return Promise.resolve(reply?.() ?? new Response(null, { status: 500 }));
  });
  return sent;
}

function signedInModel(): StreamingModel {
  let issued = 0;
  return createProvider(
    'chatgpt',
    {
      accessToken: () => {
        issued += 1;
        return Promise.resolve(`token-${issued}`);
      },
      kind: 'access_token',
    },
    'gpt-6.1-sol'
  ) as unknown as StreamingModel;
}

async function send(model: StreamingModel): Promise<Record<string, unknown>[]> {
  const { stream } = await model.doStream({
    maxOutputTokens: 4096,
    prompt: [
      { content: 'Be brief.', role: 'system' },
      { content: [{ text: 'hi', type: 'text' }], role: 'user' },
    ],
    providerOptions: { openai: { reasoningEffort: 'low' } },
    temperature: 0.5,
    topP: 0.9,
  });
  const parts: Record<string, unknown>[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return parts;
    }
    parts.push(value);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('createProvider chatgpt case (ADR-0038)', () => {
  it('sends each request to the public Responses API with the token asked for that request', async () => {
    // An OpenAI base URL in the environment must never receive a person's ChatGPT token.
    vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.example/v1');
    const sent = stubOpenAi(() => serverSentEvents(COMPLETED));
    const model = signedInModel();

    await send(model);
    await send(model);

    expect(sent.map(({ url }) => url)).toEqual([
      'https://api.openai.com/v1/responses',
      'https://api.openai.com/v1/responses',
    ]);
    expect(sent.map(({ authorization }) => authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
  });

  it('shapes the request as a ChatGPT plan accepts it', async () => {
    const sent = stubOpenAi(() => serverSentEvents(COMPLETED));

    await send(signedInModel());

    const body = sent[0]?.body ?? {};
    expect(body).toMatchObject({
      include: ['reasoning.encrypted_content'],
      model: 'gpt-6.1-sol',
      reasoning: { effort: 'low' },
      store: false,
      stream: true,
    });
    // System text travels as a developer message: the route rejects `system` items.
    expect(body['input']).toEqual([
      { content: 'Be brief.', role: 'developer' },
      { content: [{ text: 'hi', type: 'input_text' }], role: 'user' },
    ]);
    for (const refused of ['max_output_tokens', 'temperature', 'top_p', 'previous_response_id']) {
      expect(body, refused).not.toHaveProperty(refused);
    }
  });

  it('answers a caller that asks for a whole reply from the stream the route requires', async () => {
    // Thread titles, compaction summaries and auto-review ask for one reply, not a stream.
    const sent = stubOpenAi(() => serverSentEvents(COMPLETED));

    const reply = await signedInModel().doGenerate({
      prompt: [{ content: [{ text: 'Name this thread.', type: 'text' }], role: 'user' }],
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ store: false, stream: true });
    expect(reply.content).toMatchObject([{ text: 'Hello', type: 'text' }]);
    expect(reply.finishReason.unified).toBe('stop');
    expect(reply.usage).toMatchObject({ inputTokens: { total: 1 }, outputTokens: { total: 1 } });
  });

  it('refuses every credential but a sign-in, so a metered key never pays for plan requests', () => {
    for (const auth of [undefined, { apiKey: 'sk-fixture', kind: 'api_key' } as const]) {
      expect(() => createProvider('chatgpt', auth, 'gpt-6.1-sol')).toThrow(MastraAgentError);
    }
    expect(() =>
      createProvider(
        'openai',
        { accessToken: () => Promise.resolve('token'), kind: 'access_token' },
        'gpt-6.1-sol'
      )
    ).toThrow(MastraAgentError);
  });

  it('turns a usage limit into a refusal that points at ChatGPT usage settings', async () => {
    stubOpenAi(
      () =>
        new Response(JSON.stringify({ error: USAGE_LIMIT }), {
          headers: { 'content-type': 'application/json' },
          status: 429,
        }),
      // The limit can also arrive after the stream has opened.
      () =>
        serverSentEvents([
          { response: { error: USAGE_LIMIT, id: 'resp_2' }, type: 'response.failed' },
        ])
    );
    const model = signedInModel();

    const refused = await send(model).catch((cause: unknown) => cause);
    const failedInStream = (await send(model)).find((part) => part['type'] === 'error');

    for (const cause of [refused, failedInStream?.['error']]) {
      const classified = classifyChatGptPlanError(cause);
      expect(classified).toBeInstanceOf(BoundaryFailureError);
      expect((classified as BoundaryFailureError).failure).toMatchObject({
        code: 'provider.chatgpt-usage-limit',
        kind: 'refusal',
        remedy: 'Review and manage your usage at https://chatgpt.com/settings/usage.',
      });
    }
  });

  it('leaves an error that is not a plan refusal as it was', () => {
    const cause = new Error('socket hang up');
    expect(classifyChatGptPlanError(cause)).toBe(cause);
  });
});
