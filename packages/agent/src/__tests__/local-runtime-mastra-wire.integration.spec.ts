import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { streamMastraAgent } from '../mastra/agent-runtime';
import type { RuntimeData } from '../types';

interface CapturedRequest {
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
  readonly url: string | undefined;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

async function startOpenAiCompatibleServer(): Promise<{
  readonly origin: string;
  readonly requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push({
        authorization: request.headers.authorization,
        body,
        url: request.url,
      });

      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: { content: 'local runtime ok', role: 'assistant' },
              finish_reason: null,
              index: 0,
            },
          ],
          created: 1,
          id: 'chatcmpl-local-runtime',
          model: body['model'],
          object: 'chat.completion.chunk',
        })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
          created: 1,
          id: 'chatcmpl-local-runtime',
          model: body['model'],
          object: 'chat.completion.chunk',
          usage: { completion_tokens: 3, prompt_tokens: 4, total_tokens: 7 },
        })}\n\n`
      );
      response.end('data: [DONE]\n\n');
    });
  });
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

describe('local runtime Mastra wire contract', () => {
  it.each([
    {
      expectedAuthorization: 'Bearer ollama',
      model: 'qwen3:latest',
      provider: 'ollama' as const,
    },
    {
      apiToken: 'lmstudio-token',
      expectedAuthorization: 'Bearer lmstudio-token',
      model: 'google/gemma-4-26b-a4b-qat',
      provider: 'lmstudio' as const,
    },
  ])('streams $provider through Mastra OpenAI-compatible chat completions', async (testCase) => {
    const server = await startOpenAiCompatibleServer();
    const providerOptions: NonNullable<RuntimeData['providerOptions']> = {
      [testCase.provider]: {
        ...(testCase.apiToken ? { apiToken: testCase.apiToken } : {}),
        baseUrl: server.origin,
      },
    };
    const iterator = await streamMastraAgent(
      [{ id: 'user-1', parts: [{ text: 'Reply briefly.', type: 'text' }], role: 'user' }],
      {
        model: testCase.model,
        runtime: {
          apiKey: '',
          provider: testCase.provider,
          providerOptions,
        },
      }
    );

    let text = '';
    for await (const chunk of iterator) {
      if (chunk.type === 'text-delta') {
        text += chunk.value;
      }
    }

    expect(text).toBe('local runtime ok');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      authorization: testCase.expectedAuthorization,
      body: { model: testCase.model, stream: true },
      url: '/v1/chat/completions',
    });
    expect(server.requests[0]?.body).not.toHaveProperty('apiToken');
    expect(server.requests[0]?.body).not.toHaveProperty('baseUrl');
  });
});
