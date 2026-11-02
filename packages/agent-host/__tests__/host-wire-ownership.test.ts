import { Schema } from 'effect';
import { expect, test } from 'vitest';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  HOST_METHOD_SCHEMAS,
  HOST_RESULT_SCHEMAS,
  HostEventSchema,
  parseHostParams,
} from '../src/protocol.js';
import wireV19 from './fixtures/host-v19-methods.json' with { type: 'json' };

test('every first-party host request/result/event grammar has one Effect owner', () => {
  const requests = Object.entries(HOST_METHOD_SCHEMAS);
  const results = Object.entries(HOST_RESULT_SCHEMAS);
  expect(AGENT_HOST_PROTOCOL_VERSION).toBe(wireV19.version);
  expect(requests.map(([name]) => name).sort()).toEqual(wireV19.methods);
  expect(results.map(([name]) => name).sort()).toEqual(requests.map(([name]) => name).sort());
  expect(
    [...requests, ...results, ['event', HostEventSchema]]
      .filter(([, schema]) => !Schema.isSchema(schema))
      .map(([name]) => name)
  ).toEqual([]);
});

test('protocol version and secret-bearing request refusal stay fixed', () => {
  expect(AGENT_HOST_PROTOCOL_VERSION).toBe(19);
  const badAccess = { access: 'x', catalogId: 'github', token: 'never-print-me' };
  expect(() => parseHostParams('mcp/config/install', badAccess)).toThrow(
    'Invalid MCP host request'
  );
  expect(() => parseHostParams('mcp/config/install', badAccess)).not.toThrow('never-print-me');
  const excessKey = {
    access: 'read-write',
    catalogId: 'github',
    secretRider: 'never-print-me',
    token: 'never-print-me',
  };
  expect(() => parseHostParams('mcp/config/install', excessKey)).toThrow(
    'Invalid MCP host request'
  );
  expect(() => parseHostParams('mcp/config/install', excessKey)).not.toThrow('never-print-me');
});

test('v12 MCP config writes require the base revision and return the new one', () => {
  const revision = 'a'.repeat(64);
  const decodeResult = (method: 'mcp/config/install' | 'mcp/config/read' | 'mcp/config/write') =>
    Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS[method], { onExcessProperty: 'error' });
  expect(() => parseHostParams('mcp/config/write', { content: '{}' })).toThrow(
    'Invalid MCP host request'
  );
  expect(parseHostParams('mcp/config/write', { baseRevision: revision, content: '{}' })).toEqual({
    baseRevision: revision,
    content: '{}',
  });
  const document = { content: '', created: false, exists: false, path: '/p', revision };
  expect(decodeResult('mcp/config/read')(document)).toEqual(document);
  const { revision: _, ...unrevised } = document;
  expect(() => decodeResult('mcp/config/read')(unrevised)).toThrow();
  for (const method of ['mcp/config/write', 'mcp/config/install'] as const) {
    const success = { path: '/p', revision, success: true };
    expect(decodeResult(method)(success)).toEqual(success);
    expect(() => decodeResult(method)({ path: '/p', success: true })).toThrow();
    const conflict = { conflict: true, error: 'stale', path: '/p', success: false };
    expect(decodeResult(method)(conflict)).toEqual(conflict);
    expect(() => decodeResult(method)({ ...conflict, conflict: false })).toThrow();
  }
});

test('the owned MCP settlement decoder keeps its original refusal', () => {
  expect(() => parseHostParams('mcp/elicitation/settle', {})).toThrow(
    'Invalid MCP elicitation settlement:'
  );
});
