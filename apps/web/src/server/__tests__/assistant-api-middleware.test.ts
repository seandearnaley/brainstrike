import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssistantApiMiddleware } from '../assistant-api-middleware';

class ResponseSink extends EventEmitter {
  body = '';
  headers: Record<string, string> = {};
  statusCode = 200;

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  writeHead(status: number, headers: Record<string, string>): void {
    this.statusCode = status;
    this.headers = headers;
  }

  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk;
    }
    this.emit('finish');
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
});
