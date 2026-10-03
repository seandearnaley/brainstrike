import { describe, expect, test } from 'vitest';
import { decodeHostRecord, tokensEqual } from '../src/record.js';

const record = {
  endpoint: '/tmp/brainstrike-host/socket',
  hostVersion: '0.1.0',
  pid: 42,
  protocolVersion: 1,
  start: 'real OS start',
  token: 'a'.repeat(64),
};

describe('host record boundary', () => {
  test('decodes exact lease fields and requires a 32-byte token', () => {
    expect(decodeHostRecord(record)).toEqual(record);
    for (const value of [
      { ...record, token: 'a'.repeat(62) },
      { ...record, pid: 0 },
      { ...record, start: '' },
      { ...record, unexpected: true },
      { ...record, endpoint: 'http://remote.example' },
    ]) {
      expect(() => decodeHostRecord(value)).toThrow(TypeError);
    }
  });

  test('compares decoded tokens without accepting a prefix or malformed token', () => {
    expect(tokensEqual(record.token, record.token)).toBe(true);
    expect(tokensEqual(record.token, 'b'.repeat(64))).toBe(false);
    expect(() => tokensEqual(record.token, record.token.slice(2))).toThrow(TypeError);
  });
});
