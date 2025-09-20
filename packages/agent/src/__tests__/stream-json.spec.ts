import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '../index';
import { sanitizeStreamChunk, toJsonSafe } from '../stream/json';

describe('toJsonSafe', () => {
  it('serializes diverse runtime values into JSON-friendly forms', () => {
    const error = new Error('boom');
    (error as Error & { extra?: string }).extra = 'details';

    const source = {
      date: new Date('2024-01-01T00:00:00Z'),
      buffer: Buffer.from('data'),
      typed: new Uint8Array([1, 2, 3]),
      map: new Map([['key', { nested: true }]]),
      set: new Set([1, 2, 3]),
      error,
    };

    const result = toJsonSafe(source) as Record<string, unknown>;

    expect(result['date']).toBe('2024-01-01T00:00:00.000Z');
    expect(result['buffer']).toMatchObject({ __type: 'Buffer', encoding: 'base64' });
    expect(result['typed']).toMatchObject({ __type: 'Uint8Array' });
    expect(result['map']).toEqual({ __type: 'Map', entries: { key: { nested: true } } });
    expect(result['set']).toEqual({ __type: 'Set', values: [1, 2, 3] });
    expect(result['error']).toMatchObject({ name: 'Error', message: 'boom', extra: 'details' });
  });

  it('returns circular references as [Circular]', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    const result = toJsonSafe(circular) as { self: string };
    expect(result.self).toBe('[Circular]');
  });
});

describe('sanitizeStreamChunk', () => {
  it('clones payloads and usage fields without mutating the original chunk', () => {
    const originalPayload = { map: new Map([['foo', 'bar']]) };
    const usage = { promptTokens: 1n, completionTokens: 2n };

    const chunk: StreamChunk = {
      type: 'tool-event',
      name: 'example',
      status: 'success',
      payload: originalPayload,
      usage,
    } as StreamChunk;

    const sanitized = sanitizeStreamChunk(chunk);

    expect(sanitized).not.toBe(chunk);
    const sanitizedRecord = sanitized as unknown as Record<string, unknown>;
    expect(sanitizedRecord['payload']).toEqual({
      map: { __type: 'Map', entries: { foo: 'bar' } },
    });
    expect(sanitizedRecord['usage']).toEqual({
      promptTokens: '1',
      completionTokens: '2',
    });

    // Original structures remain untouched.
    expect(originalPayload.map instanceof Map).toBe(true);
    expect(typeof usage.promptTokens).toBe('bigint');
  });
});
