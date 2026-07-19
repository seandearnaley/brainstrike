import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/agent', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
  return {
    ...actual,
    resolveDataStreamSession: vi.fn(),
    toAiSdkStyleStream: vi.fn(),
  };
});

import type { AssistantDataStreamSession, StreamChunk } from '@brainstrike/agent';
import { resolveDataStreamSession, toAiSdkStyleStream } from '@brainstrike/agent';
import { createAssistantApiMiddleware } from '../assistant-api-middleware';

class ResponseSink extends EventEmitter {
  body = '';
  destroyError: Error | undefined;
  headers: Record<string, string> = {};
  headersSent = false;
  statusCode = 200;
  destroyed = false;

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  writeHead(status: number, headers: Record<string, string>): void {
    if (this.headersSent) {
      throw new Error('ERR_HTTP_HEADERS_SENT');
    }
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
  }

  write(chunk: Uint8Array | string): boolean {
    this.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }

  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk;
    }
    this.emit('finish');
  }

  destroy(error?: Error): this {
    this.destroyed = true;
    this.destroyError = error;
    this.emit('close');
    return this;
  }
}

function createRequest(headers: http.IncomingHttpHeaders): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.headers = headers;
  req.method = 'POST';
  req.pause = vi.fn().mockReturnValue(req);
  req.resume = vi.fn().mockReturnValue(req);
  req.url = '/api/chat';
  return req;
}

describe('assistant API middleware request body limit', () => {
  beforeEach(() => {
    vi.mocked(resolveDataStreamSession).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns typed 413 before reading a declared oversized body', async () => {
    vi.stubEnv('BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES', '5');
    const middleware = createAssistantApiMiddleware('dev');
    const req = createRequest({ 'content-length': '6' });
    const res = new ResponseSink();
    const next = vi.fn();

    await middleware(req, res as unknown as http.ServerResponse, next);

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({
      error: 'request_body_too_large',
      message: 'Assistant request body exceeds 5 bytes.',
    });
    expect(req.resume).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it('enforces the bounded body before looking up an assistant resume session', async () => {
    vi.stubEnv('BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES', '5');
    vi.mocked(resolveDataStreamSession).mockReturnValue({
      createResponse: () => new Response('must-not-resume'),
    } as unknown as AssistantDataStreamSession);
    const middleware = createAssistantApiMiddleware('dev');
    const req = createRequest({
      'content-length': '6',
      'last-event-id': 'evt-oversized',
    });
    req.url = '/api/assistant';
    const res = new ResponseSink();
    const next = vi.fn();

    await middleware(req, res as unknown as http.ServerResponse, next);

    expect(res.statusCode).toBe(413);
    expect(resolveDataStreamSession).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns typed 413 when a chunked body crosses the configured limit', async () => {
    vi.stubEnv('BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES', '5');
    const middleware = createAssistantApiMiddleware('preview');
    const req = createRequest({});
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit('data', Buffer.from('abc'));
    req.emit('data', Buffer.from('def'));
    await responsePromise;

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({
      error: 'request_body_too_large',
      message: 'Assistant request body exceeds 5 bytes.',
    });
    expect(req.resume).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns canonical typed 400 for malformed JSON', async () => {
    const middleware = createAssistantApiMiddleware('dev');
    const req = createRequest({});
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit('data', Buffer.from('{"messages":'));
    req.emit('end');
    await responsePromise;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_json',
      message: 'Request body must be valid JSON.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    [
      'dev',
      '/api/chat',
      '',
      {
        error: 'invalid_json',
        message: 'Request body must be valid JSON.',
      },
    ],
    [
      'preview',
      '/api/assistant',
      '',
      {
        error: 'invalid_json',
        message: 'Request body must be valid JSON.',
      },
    ],
    [
      'dev',
      '/api/assistant',
      '{}',
      {
        error: 'invalid_request_payload',
        message: 'Assistant request payload must include its own messages array.',
      },
    ],
    [
      'preview',
      '/api/chat',
      '{}',
      {
        error: 'invalid_request_payload',
        message: 'Assistant request payload must include its own messages array.',
      },
    ],
    [
      'dev',
      '/api/chat',
      JSON.stringify({ messages: [], system: 'must stay server-owned' }),
      {
        error: 'invalid_request_payload',
        message: 'Assistant request payload contains an unsupported top-level field.',
      },
    ],
    [
      'preview',
      '/api/assistant',
      JSON.stringify({ messages: [], system: 'must stay server-owned' }),
      {
        error: 'invalid_request_payload',
        message: 'Assistant request payload contains an unsupported top-level field.',
      },
    ],
  ] as const)('returns the canonical envelope error in %s for %s', async (mode, url, body, expected) => {
    const middleware = createAssistantApiMiddleware(mode);
    const req = createRequest({});
    req.url = url;
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    if (body.length > 0) {
      req.emit('data', Buffer.from(body));
    }
    req.emit('end');
    await responsePromise;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual(expected);
    expect(next).not.toHaveBeenCalled();
  });

  it('resumes an existing assistant session before parsing its bounded body', async () => {
    vi.mocked(resolveDataStreamSession).mockReturnValue({
      createResponse: () => new Response('resumed-without-json'),
    } as unknown as AssistantDataStreamSession);
    const middleware = createAssistantApiMiddleware('preview');
    const req = createRequest({ 'last-event-id': 'evt-1' });
    req.url = '/api/assistant';
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit('data', Buffer.from('{"messages":'));
    req.emit('end');
    await responsePromise;

    expect(resolveDataStreamSession).toHaveBeenCalledWith('evt-1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('resumed-without-json');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns typed 400 for a malformed assistant message id', async () => {
    const middleware = createAssistantApiMiddleware('dev');
    const req = createRequest({});
    req.url = '/api/assistant';
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          messages: [{ role: 'user', text: 'hello' }],
          unstable_assistantMessageId: false,
        })
      )
    );
    req.emit('end');
    await responsePromise;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_messages',
      message: 'Assistant message id must be a non-empty bounded string.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('destroys a partially written Vite chat response when its stream fails', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.mocked(toAiSdkStyleStream).mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'partial' } as StreamChunk;
        throw new Error('provider stream failed');
      },
    });
    const middleware = createAssistantApiMiddleware('dev');
    const req = createRequest({});
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          messages: [{ id: 'u1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
        })
      )
    );
    req.emit('end');
    await responsePromise;

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('partial');
    expect(res.destroyed).toBe(true);
    expect(res.destroyError).toEqual(new Error('provider stream failed'));
    expect(next).not.toHaveBeenCalled();
  });
});
