import { Schema } from 'effect';
import { expect, test } from 'vitest';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  ClientOpenExternalParamsSchema,
  HOST_METHOD_SCHEMAS,
  HOST_RESULT_SCHEMAS,
  HostEventSchema,
  parseHostParams,
} from '../src/protocol.js';
import wireV11 from './fixtures/host-v11-methods.json' with { type: 'json' };

test('every first-party host request/result/event grammar has one Effect owner', () => {
  const requests = Object.entries(HOST_METHOD_SCHEMAS);
  const results = Object.entries(HOST_RESULT_SCHEMAS);
  expect(AGENT_HOST_PROTOCOL_VERSION).toBe(wireV11.version);
  expect(requests.map(([name]) => name).sort()).toEqual(wireV11.methods);
  expect(results.map(([name]) => name).sort()).toEqual(requests.map(([name]) => name).sort());
  expect(
    [...requests, ...results, ['event', HostEventSchema]]
      .filter(([, schema]) => !Schema.isSchema(schema))
      .map(([name]) => name)
  ).toEqual([]);
});

test('protocol version and secret-bearing request refusal stay fixed', () => {
  expect(AGENT_HOST_PROTOCOL_VERSION).toBe(11);
  expect(parseHostParams('auth/connect', { method: undefined, provider: 'openai' })).toEqual({
    method: undefined,
    provider: 'openai',
  });
  expect(() =>
    parseHostParams('auth/connect', { provider: 'openai', secretRider: 'never-print-me' })
  ).toThrow('Invalid MCP host request');
  expect(() =>
    parseHostParams('auth/connect', { provider: 'openai', secretRider: 'never-print-me' })
  ).not.toThrow('secretRider');
  expect(() => parseHostParams('auth/clear', [])).toThrow('Invalid MCP host request');
  expect(() => parseHostParams('auth/clear', 1)).toThrow('Invalid MCP host request');
});

test('external URL normalization preserves the former URL decoder output', () => {
  expect(
    Schema.decodeUnknownSync(ClientOpenExternalParamsSchema, { onExcessProperty: 'error' })({
      url: ' \thttps://exa\nmple.test/path\r ',
    })
  ).toEqual({ url: 'https://example.test/path' });
});
