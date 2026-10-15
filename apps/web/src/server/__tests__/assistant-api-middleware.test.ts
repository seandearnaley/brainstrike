import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The assistant handler itself is covered in `assistant-stream-helpers.test.ts`.
 * This suite owns the middleware around it, so one case needs the handler to
 * fail AFTER it has written headers; everything else runs the real handler.
 */
let handleAssistantEndpointOverride:
  | ((req: http.IncomingMessage, res: http.ServerResponse, bodyText: string) => Promise<void>)
  | null = null;

vi.mock('../../assistant-stream-helpers', async () => {
  const actual = await vi.importActual<typeof import('../../assistant-stream-helpers')>(
    '../../assistant-stream-helpers'
  );
  return {
    ...actual,
    handleAssistantEndpoint: async (
      req: http.IncomingMessage,
      res: http.ServerResponse,
      bodyText: string
    ): Promise<void> =>
      handleAssistantEndpointOverride
        ? await handleAssistantEndpointOverride(req, res, bodyText)
        : await actual.handleAssistantEndpoint(req, res, bodyText),
  };
});

vi.mock('@brainstrike/agent', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
  return {
    ...actual,
    resolveDataStreamSession: vi.fn(),
  };
});

import type { AssistantDataStreamSession } from '@brainstrike/agent';
import { resolveDataStreamSession } from '@brainstrike/agent';
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

interface RequestOptions {
  readonly method?: string;
  readonly remoteAddress?: string | null;
  readonly url?: string;
}

function createRequest(
  headers: http.IncomingHttpHeaders,
  options: RequestOptions = {}
): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.headers = {
    'content-type': 'application/json',
    host: 'localhost:8080',
    ...headers,
  };
  req.method = options.method ?? 'POST';
  req.pause = vi.fn().mockReturnValue(req);
  req.resume = vi.fn().mockReturnValue(req);
  Object.defineProperty(req, 'socket', {
    configurable: true,
    value: {
      remoteAddress:
        options.remoteAddress === null ? undefined : (options.remoteAddress ?? '127.0.0.1'),
    },
  });
  req.url = options.url ?? '/api/assistant';
  return req;
}

describe('assistant API middleware local request boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['private IPv4', '192.168.1.25'],
    ['public IPv4', '203.0.113.10'],
    ['non-loopback IPv6', '2001:db8::10'],
    ['missing address', null],
  ])('rejects a %s client before reading the assistant body', async (_case, remoteAddress) => {
    const middleware = createAssistantApiMiddleware('dev');
    const req = createRequest({}, { remoteAddress });
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit('data', Buffer.from('{}'));
    req.emit('end');
    await responsePromise;

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'local_assistant_loopback_required',
      message: 'Local assistant API requests must originate from a loopback client.',
    });
    expect(req.resume).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    'attacker.example:8080',
    'localhost.attacker.example:8080',
    '0.0.0.0:8080',
    '192.168.1.25:8080',
  ])('rejects the untrusted Host header %s', async (host) => {
    const middleware = createAssistantApiMiddleware('preview');
    const req = createRequest({ host });
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit('data', Buffer.from('{}'));
    req.emit('end');
    await responsePromise;

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'local_assistant_host_forbidden',
      message: 'Local assistant API requests require a trusted loopback Host header.',
    });
    expect(req.resume).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a missing Host header', async () => {
    const middleware = createAssistantApiMiddleware('dev');
    const req = createRequest({ host: undefined });
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit('data', Buffer.from('{}'));
    req.emit('end');
    await responsePromise;

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('local_assistant_host_forbidden');
    expect(req.resume).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['cross-origin host', 'http://attacker.example:8080', undefined],
    ['cross-origin port', 'http://localhost:9090', undefined],
    ['opaque origin', 'null', undefined],
    ['malformed origin', 'not-an-origin', undefined],
    ['contradictory fetch metadata', 'http://localhost:8080', 'cross-site'],
  ])('rejects %s', async (_case, origin, secFetchSite) => {
    const middleware = createAssistantApiMiddleware('dev');
    const req = createRequest({
      origin,
      ...(secFetchSite ? { 'sec-fetch-site': secFetchSite } : {}),
    });
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit('data', Buffer.from('{}'));
    req.emit('end');
    await responsePromise;

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'local_assistant_origin_forbidden',
      message: 'Local assistant API browser requests must be same-origin.',
    });
    expect(req.resume).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['localhost', '127.0.0.1', 'localhost:8080', 'http://localhost:8080'],
    ['IPv4 loopback', '127.42.0.8', '127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['IPv6 loopback', '::1', '[::1]:8080', 'http://[::1]:8080'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1', 'localhost:8080', 'http://localhost:8080'],
  ])('admits a same-origin %s request', async (_case, remoteAddress, host, origin) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const middleware = createAssistantApiMiddleware('dev');
    const req = createRequest({ host, origin }, { remoteAddress });
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit('data', Buffer.from('{"messages":'));
    req.emit('end');
    await responsePromise;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_json');
    expect(req.resume).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('admits a no-Origin local CLI request', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const middleware = createAssistantApiMiddleware('preview');
    const req = createRequest({});
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit('data', Buffer.from('{"messages":'));
    req.emit('end');
    await responsePromise;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_json');
    expect(req.resume).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it.each([undefined, 'text/plain', 'application/json-patch+json'])(
    'rejects POST Content-Type %s',
    async (contentType) => {
      const middleware = createAssistantApiMiddleware('dev');
      const req = createRequest({ 'content-type': contentType });
      const res = new ResponseSink();
      const next = vi.fn();
      const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

      req.emit('data', Buffer.from('{}'));
      req.emit('end');
      await responsePromise;

      expect(res.statusCode).toBe(415);
      expect(JSON.parse(res.body)).toEqual({
        error: 'local_assistant_json_required',
        message: 'Local assistant API POST requests require Content-Type: application/json.',
      });
      expect(req.resume).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
    }
  );

  it('admits application/json with a charset parameter', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const middleware = createAssistantApiMiddleware('dev');
    const req = createRequest({ 'content-type': 'Application/JSON; charset=UTF-8' });
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit('data', Buffer.from('{"messages":'));
    req.emit('end');
    await responsePromise;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_json');
    expect(req.resume).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('applies the loopback boundary to the status endpoint', async () => {
    const middleware = createAssistantApiMiddleware('preview');
    const req = createRequest(
      {},
      {
        method: 'GET',
        remoteAddress: '192.168.1.25',
        url: '/api/assistant/status',
      }
    );
    const res = new ResponseSink();
    const next = vi.fn();

    await middleware(req, res as unknown as http.ServerResponse, next);

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('local_assistant_loopback_required');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('assistant API middleware request body limit', () => {
  afterEach(() => {
    handleAssistantEndpointOverride = null;
  });

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
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
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
      '/api/assistant',
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
      '/api/assistant',
      '{}',
      {
        error: 'invalid_request_payload',
        message: 'Assistant request payload must include its own messages array.',
      },
    ],
    [
      'dev',
      '/api/assistant',
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
  ] as const)(
    'returns the canonical envelope error in %s for %s',
    async (mode, url, body, expected) => {
      // Convergence (BST-973-2): the assistant path's 503 server-config gate now
      // precedes validation, so a configured provider is needed to reach the 400s.
      vi.stubEnv('OPENAI_API_KEY', 'test-key');
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
    }
  );

  it('rejects last-event-id before parsing its bounded body or consulting local sessions', async () => {
    const middleware = createAssistantApiMiddleware('preview');
    const req = createRequest({ 'last-event-id': 'evt-1' });
    req.url = '/api/assistant';
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit('data', Buffer.from('{"messages":'));
    req.emit('end');
    await responsePromise;

    expect(resolveDataStreamSession).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: 'stream_resume_unavailable',
      message:
        'Hosted Web stream replay requires durable storage and is unavailable for this deployment.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns typed 400 for a malformed assistant message id', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
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

  it('destroys a partially written Vite assistant response when its stream fails', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    // Headers are already out, so the error cannot become a status code; the
    // middleware must tear the socket down instead of ending a truncated
    // response that reads as a complete one.
    handleAssistantEndpointOverride = async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.write('partial');
      throw new Error('provider stream failed');
    };
    const middleware = createAssistantApiMiddleware('dev');
    const req = createRequest({});
    const res = new ResponseSink();
    const next = vi.fn();
    const responsePromise = middleware(req, res as unknown as http.ServerResponse, next);

    req.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          data: { provider: 'openai' },
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
