import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { decodeStoredHostEvent } from '../src/host-event-decoding.js';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  HOST_METHOD_SCHEMAS,
  HOST_RESULT_SCHEMAS,
  HostEventSchema,
  parseHostParams,
} from '../src/protocol.js';
import wireV30 from './fixtures/host-v30-methods.json' with { type: 'json' };

test('every first-party host request/result/event grammar has one Effect owner', () => {
  const requests = Object.entries(HOST_METHOD_SCHEMAS);
  const results = Object.entries(HOST_RESULT_SCHEMAS);
  expect(AGENT_HOST_PROTOCOL_VERSION).toBe(wireV30.version);
  expect(requests.map(([name]) => name).sort()).toEqual(wireV30.methods);
  expect(results.map(([name]) => name).sort()).toEqual(requests.map(([name]) => name).sort());
  expect(
    [...requests, ...results, ['event', HostEventSchema]]
      .filter(([, schema]) => !Schema.isSchema(schema))
      .map(([name]) => name)
  ).toEqual([]);
});

test('protocol version and secret-bearing request refusal stay fixed', () => {
  expect(AGENT_HOST_PROTOCOL_VERSION).toBe(30);
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

test('v30 worktree archives name their reason, and a merged one its default branch', () => {
  const decode = Schema.decodeUnknownSync(HostEventSchema, { onExcessProperty: 'error' });
  const worktree = {
    branch: 'bs/swift-badger',
    name: 'swift-badger',
    snapshotRef: 'refs/brainstrike/worktree-archive/wt-1',
    worktreeId: 'wt-1',
  };
  const archived = { runId: 'run-1', type: 'worktrees.archived', worktrees: [worktree] };
  const idle = { ...archived, limit: 15, reason: 'idle-cap' };
  const merged = { ...archived, defaultBranch: 'origin/main', reason: 'merged' };
  expect(decode(idle)).toEqual(idle);
  expect(decode(merged)).toEqual(merged);
  expect(() => decode({ ...archived, reason: 'merged' })).toThrow();
  expect(() => decode({ ...merged, limit: 15 })).toThrow();
  expect(() => decode({ ...merged, worktrees: [{ ...worktree, branch: null }] })).toThrow();
});

// v25 to v29 hosts committed the cap's archive with no reason; a thread holding one still reads.
test('a stored worktree archive with no reason reads as the idle cap’s', () => {
  const v29 = {
    limit: 15,
    runId: 'run-1',
    type: 'worktrees.archived',
    worktrees: [
      {
        branch: null,
        name: 'calm-otter',
        snapshotRef: 'refs/brainstrike/worktree-archive/wt-2',
        worktreeId: 'wt-2',
      },
    ],
  };
  expect(decodeStoredHostEvent(v29)).toEqual(v29);
  // With neither a reason nor a limit it is neither archive.
  const { limit: _, ...unlimited } = v29;
  expect(() => decodeStoredHostEvent(unlimited)).toThrow();
});

test('the owned MCP settlement decoder keeps its original refusal', () => {
  expect(() => parseHostParams('mcp/elicitation/settle', {})).toThrow(
    'Invalid MCP elicitation settlement:'
  );
});
