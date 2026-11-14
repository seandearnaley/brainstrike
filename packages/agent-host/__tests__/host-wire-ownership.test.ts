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
import wireV36 from './fixtures/host-v36-methods.json' with { type: 'json' };

test('every first-party host request/result/event grammar has one Effect owner', () => {
  const requests = Object.entries(HOST_METHOD_SCHEMAS);
  const results = Object.entries(HOST_RESULT_SCHEMAS);
  expect(AGENT_HOST_PROTOCOL_VERSION).toBe(wireV36.version);
  expect(requests.map(([name]) => name).sort()).toEqual(wireV36.methods);
  expect(results.map(([name]) => name).sort()).toEqual(requests.map(([name]) => name).sort());
  expect(
    [...requests, ...results, ['event', HostEventSchema]]
      .filter(([, schema]) => !Schema.isSchema(schema))
      .map(([name]) => name)
  ).toEqual([]);
});

test('protocol version and secret-bearing request refusal stay fixed', () => {
  expect(AGENT_HOST_PROTOCOL_VERSION).toBe(36);
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

// v31 (BST-2511): a repository found inside an open folder has a project, which the listing names
// on its own checkout's entry and which the person joins to another by that checkout's path.
test('a v31 worktree listing entry names its project, and a repository joins a project by its path', () => {
  const entry = {
    branch: 'main',
    containment: ['root-container'],
    createdAt: null,
    detached: false,
    disabledReason: "This is the repository's primary checkout — use Hand off to Local instead.",
    externalTool: null,
    id: null,
    lockedReason: null,
    managed: false,
    name: 'inner',
    path: '/code/container/inner',
    primary: true,
    projectId: 'project-inner',
    projectName: null,
    provenance: 'scanned',
    remedy: null,
    repoCommonDir: '/code/container/inner/.git',
    repositoryRoot: '/code/container/inner',
    rootId: 'root-container',
    rootIdIsExactMount: false,
    setupReason: null,
    setupStatus: 'none',
    trust: 'validated',
    trustReason: null,
    usable: false,
  };
  const decodeList = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['worktrees/list'], {
    onExcessProperty: 'error',
  });
  expect(decodeList({ ok: true, value: [entry] })).toEqual({ ok: true, value: [entry] });
  // The field is required: an older host's entry, which has none, is not a v31 entry.
  const { projectId: _, projectName: __, ...older } = entry;
  expect(() => decodeList({ ok: true, value: [older] })).toThrow();

  const repositoryPath = '/code/container/inner';
  expect(parseHostParams('projects/join', { projectId: 'p', repositoryPath })).toEqual({
    projectId: 'p',
    repositoryPath,
  });
  expect(parseHostParams('projects/join', { projectId: 'p', rootId: 'r' })).toEqual({
    projectId: 'p',
    rootId: 'r',
  });
  expect(() => parseHostParams('projects/join', { projectId: 'p' })).toThrow();
  // BST-2520: such a repository's first name makes its project, so it is named by its path too.
  expect(parseHostParams('projects/rename', { name: 'Inner', repositoryPath })).toEqual({
    name: 'Inner',
    repositoryPath,
  });
  expect(parseHostParams('projects/rename', { name: 'Inner', projectId: 'p' })).toEqual({
    name: 'Inner',
    projectId: 'p',
  });
  expect(() => parseHostParams('projects/rename', { name: 'Inner' })).toThrow();
});

// v36 (BST-2501, Sean 2026-11-14): a setup script answer says whether it also runs the script for
// the worktrees Brainstrike makes on its own; nothing assumes it.
test('a v36 setup script answer carries its second answer, which is required', () => {
  const scriptSha256 = 'a'.repeat(64);
  const answer = { brainstrikeWorktrees: false, decision: 'approved', rootId: 'r', scriptSha256 };
  expect(parseHostParams('worktrees/setup-consent/decide', answer)).toEqual(answer);
  const { brainstrikeWorktrees: _, ...older } = answer;
  expect(() => parseHostParams('worktrees/setup-consent/decide', older)).toThrow();

  const consent = {
    brainstrikeWorktrees: true,
    decidedAt: '2026-11-14T00:00:00.000Z',
    decision: 'approved',
    repositoryId: '/code/app/.git',
    scriptSha256,
  };
  const decodeList = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['worktrees/setup-consent/list'], {
    onExcessProperty: 'error',
  });
  expect(decodeList({ ok: true, value: [consent] })).toEqual({ ok: true, value: [consent] });
  const { brainstrikeWorktrees: __, ...olderConsent } = consent;
  expect(() => decodeList({ ok: true, value: [olderConsent] })).toThrow();

  const context = {
    managedParentPath: '/managed/app',
    repositorySetup: {
      brainstrikeWorktrees: false,
      decision: null,
      repositoryId: '/code/app/.git',
      repositoryPath: '/code/app',
      scriptPath: '/code/app/.brainstrike/worktree-setup.sh',
      scriptSha256,
    },
    suggestedName: 'swift-badger',
  };
  const decodeContext = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['worktrees/create-context'], {
    onExcessProperty: 'error',
  });
  expect(decodeContext({ ok: true, value: context })).toEqual({ ok: true, value: context });
  const { brainstrikeWorktrees: ___, ...olderSetup } = context.repositorySetup;
  expect(() =>
    decodeContext({ ok: true, value: { ...context, repositorySetup: olderSetup } })
  ).toThrow();
});

test('the owned MCP settlement decoder keeps its original refusal', () => {
  expect(() => parseHostParams('mcp/elicitation/settle', {})).toThrow(
    'Invalid MCP elicitation settlement:'
  );
});
