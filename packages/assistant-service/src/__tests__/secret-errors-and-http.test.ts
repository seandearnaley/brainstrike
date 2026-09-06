import type http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { respondAssistantRejection, respondJson, respondNotFound } from '../http.js';
import { getSecretReadErrorPayload } from '../secret-errors.js';

interface RecordedResponse {
  end: ReturnType<typeof vi.fn>;
  headers: Map<string, string>;
  statusCode: number;
  writeHead: ReturnType<typeof vi.fn>;
}

function makeServerResponse(): http.ServerResponse & RecordedResponse {
  const headers = new Map<string, string>();
  const response: RecordedResponse = {
    end: vi.fn(),
    headers,
    statusCode: 200,
    writeHead: vi.fn(function writeHead(status: number) {
      response.statusCode = status;
      return response as unknown as http.ServerResponse;
    }),
  };
  Object.defineProperty(response, 'setHeader', {
    value: vi.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    }),
  });
  return response as unknown as http.ServerResponse & RecordedResponse;
}

describe('respondAssistantRejection', () => {
  it('marks connection-close rejections so the transport honors them', () => {
    const res = makeServerResponse();
    respondAssistantRejection(res, {
      closeConnection: true,
      payload: { error: 'request_body_too_large', message: 'too big' },
      status: 413,
    });

    expect(res.headers.get('connection')).toBe('close');
    expect(res.statusCode).toBe(413);
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({ error: 'request_body_too_large', message: 'too big' })
    );
  });

  it('writes plain rejections without inventing a connection instruction', () => {
    const res = makeServerResponse();
    respondAssistantRejection(res, {
      payload: { error: 'not_found' },
      status: 404,
    });

    expect(res.headers.has('connection')).toBe(false);
    expect(res.statusCode).toBe(404);
  });
});

describe('respondNotFound', () => {
  it('answers 404 with the plain-text body hosts previously served', () => {
    const res = makeServerResponse();
    respondNotFound(res);

    expect(res.writeHead).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalledWith('not found');
  });
});

describe('respondJson', () => {
  it('routes through the shared writer with the standard JSON content type', () => {
    const res = makeServerResponse();
    respondJson(res, 503, { error: 'unavailable', message: 'warming up' });

    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.statusCode).toBe(503);
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({ error: 'unavailable', message: 'warming up' })
    );
  });
});

describe('getSecretReadErrorPayload', () => {
  it('shapes a revived secret-read failure into the wire payload', () => {
    expect(
      getSecretReadErrorPayload({
        code: 'decrypt_failed',
        message: 'keychain denied',
        name: 'SecretReadError',
        provider: 'openai',
      })
    ).toEqual({
      code: 'decrypt_failed',
      error: 'api_key_unreadable',
      message: 'keychain denied',
      provider: 'openai',
    });
  });

  it('passes ordinary errors through as undefined', () => {
    expect(getSecretReadErrorPayload(new Error('plain failure'))).toBeUndefined();
    expect(getSecretReadErrorPayload(undefined)).toBeUndefined();
    expect(
      getSecretReadErrorPayload({
        code: 'not_a_real_code',
        message: 'm',
        name: 'SecretReadError',
        provider: 'p',
      })
    ).toBeUndefined();
  });
});
