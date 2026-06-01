import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  readRequestBodyText,
  resolveAssistantRequestBodyLimitBytes,
} from '../assistant-request';

describe('assistant request helpers', () => {
  it('uses the default request body byte limit when no override is configured', () => {
    expect(resolveAssistantRequestBodyLimitBytes(undefined)).toBe(
      DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES
    );
    expect(resolveAssistantRequestBodyLimitBytes('')).toBe(
      DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES
    );
  });

  it('accepts a positive integer request body byte limit override', () => {
    expect(resolveAssistantRequestBodyLimitBytes('5')).toBe(5);
  });

  it.each([
    '0',
    '-1',
    '1.5',
    'not-a-number',
  ])('throws for invalid request body byte limit override %s', (value) => {
    expect(() => resolveAssistantRequestBodyLimitBytes(value)).toThrow(
      'BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES must be a positive integer byte count'
    );
  });

  it('rejects declared oversized request bodies before reading', async () => {
    const req = new Request('http://localhost/api/chat', {
      headers: { 'content-length': '6' },
      method: 'POST',
    });

    await expect(readRequestBodyText(req, 5)).rejects.toThrow(
      'Assistant request body exceeds 5 bytes.'
    );
  });

  it('rejects chunked request bodies when the streamed bytes exceed the limit', async () => {
    const req = new Request('http://localhost/api/chat', {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'));
          controller.enqueue(new TextEncoder().encode('!'));
          controller.close();
        },
      }),
      duplex: 'half',
      method: 'POST',
    } as RequestInit & { duplex: 'half' });

    await expect(readRequestBodyText(req, 5)).rejects.toThrow(
      'Assistant request body exceeds 5 bytes.'
    );
  });
});
