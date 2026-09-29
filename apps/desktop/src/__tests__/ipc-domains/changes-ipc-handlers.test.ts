import type {
  Changeset,
  ChangesetView,
  GitInventory,
  GitResult,
  StructuredFileDiff,
} from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createChangesIpcHandlers,
  validateChangeset,
  validatePath,
} from '../../changes-ipc-handlers';

const VIEW: ChangesetView = {
  changeset: { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' },
  files: [],
  totalAdditions: null,
  totalDeletions: null,
};

const DIFF: StructuredFileDiff = {
  additions: null,
  content: { kind: 'binary' },
  deletions: null,
  hunks: [],
  path: 'src/file.ts',
  status: 'modified',
};

function fakeService(
  overrides: Partial<{
    fileDiff: (
      rootId: unknown,
      changeset: Changeset,
      path: string
    ) => Promise<GitResult<StructuredFileDiff>>;
    resolveView: (rootId: unknown, changeset: Changeset) => Promise<GitResult<ChangesetView>>;
  }> = {}
) {
  return {
    fileDiff: overrides.fileDiff ?? vi.fn(async () => ({ ok: true, value: DIFF }) as const),
    resolveView: overrides.resolveView ?? vi.fn(async () => ({ ok: true, value: VIEW }) as const),
  };
}

describe('validateChangeset', () => {
  it('rejects a non-object payload', () => {
    const result = validateChangeset('nope');
    expect(result).toEqual({
      error: 'changeset payload must be an object with an explicit kind',
      ok: false,
    });
  });

  it('rejects an unknown kind, naming it', () => {
    const result = validateChangeset({ kind: 'mystery' });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('"mystery"');
  });

  describe('agent-run', () => {
    it('accepts a valid payload', () => {
      const result = validateChangeset({ kind: 'agent-run', runId: 'r1', threadId: 't1' });
      expect(result).toEqual({
        ok: true,
        value: { kind: 'agent-run', runId: 'r1', threadId: 't1' },
      });
    });

    it('rejects a missing runId', () => {
      const result = validateChangeset({ kind: 'agent-run', threadId: 't1' });
      expect(result).toEqual({
        error: 'changeset kind "agent-run" requires a non-empty runId',
        ok: false,
      });
    });

    it('rejects an empty threadId', () => {
      const result = validateChangeset({ kind: 'agent-run', runId: 'r1', threadId: '' });
      expect(result).toEqual({
        error: 'changeset kind "agent-run" requires a non-empty threadId',
        ok: false,
      });
    });

    it('rejects extra keys', () => {
      const result = validateChangeset({
        extra: true,
        kind: 'agent-run',
        runId: 'r1',
        threadId: 't1',
      });
      expect(result).toEqual({
        error: 'changeset kind "agent-run" does not accept: extra',
        ok: false,
      });
    });
  });

  describe('run-range', () => {
    it('accepts an open-ended range (toRunId omitted)', () => {
      const result = validateChangeset({ fromRunId: 'r1', kind: 'run-range', threadId: 't1' });
      expect(result).toEqual({
        ok: true,
        value: { fromRunId: 'r1', kind: 'run-range', threadId: 't1' },
      });
    });

    it('accepts an explicit toRunId', () => {
      const result = validateChangeset({
        fromRunId: 'r1',
        kind: 'run-range',
        threadId: 't1',
        toRunId: 'r2',
      });
      expect(result).toEqual({
        ok: true,
        value: { fromRunId: 'r1', kind: 'run-range', threadId: 't1', toRunId: 'r2' },
      });
    });

    it('rejects an empty toRunId when present', () => {
      const result = validateChangeset({
        fromRunId: 'r1',
        kind: 'run-range',
        threadId: 't1',
        toRunId: '',
      });
      expect(result).toEqual({
        error: 'changeset kind "run-range" toRunId must be a non-empty string when present',
        ok: false,
      });
    });

    it('rejects a missing fromRunId', () => {
      const result = validateChangeset({ kind: 'run-range', threadId: 't1' });
      expect(result).toEqual({
        error: 'changeset kind "run-range" requires a non-empty fromRunId',
        ok: false,
      });
    });
  });

  describe('git-scope', () => {
    it('accepts uncommitted scope', () => {
      const result = validateChangeset({
        kind: 'git-scope',
        repositoryRoot: '/repo',
        scope: { kind: 'uncommitted' },
        worktreePath: '/repo',
      });
      expect(result).toEqual({
        ok: true,
        value: {
          kind: 'git-scope',
          repositoryRoot: '/repo',
          scope: { kind: 'uncommitted' },
          worktreePath: '/repo',
        },
      });
    });

    it('accepts commit scope with a commitId', () => {
      const result = validateChangeset({
        kind: 'git-scope',
        repositoryRoot: '/repo',
        scope: { commitId: 'abc123', kind: 'commit' },
        worktreePath: '/repo',
      });
      expect(result.ok).toBe(true);
    });

    it('rejects commit scope without a commitId', () => {
      const result = validateChangeset({
        kind: 'git-scope',
        repositoryRoot: '/repo',
        scope: { kind: 'commit' },
        worktreePath: '/repo',
      });
      expect(result).toEqual({
        error: 'git-scope scope kind "commit" requires a non-empty commitId',
        ok: false,
      });
    });

    it('accepts branch-vs-base with an omitted baseRef', () => {
      const result = validateChangeset({
        kind: 'git-scope',
        repositoryRoot: '/repo',
        scope: { kind: 'branch-vs-base' },
        worktreePath: '/repo',
      });
      expect(result).toEqual({
        ok: true,
        value: {
          kind: 'git-scope',
          repositoryRoot: '/repo',
          scope: { kind: 'branch-vs-base' },
          worktreePath: '/repo',
        },
      });
    });

    it('rejects an invalid scope.kind, naming it', () => {
      const result = validateChangeset({
        kind: 'git-scope',
        repositoryRoot: '/repo',
        scope: { kind: 'bogus' },
        worktreePath: '/repo',
      });
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toContain('"bogus"');
    });

    it('rejects extra keys inside scope', () => {
      const result = validateChangeset({
        kind: 'git-scope',
        repositoryRoot: '/repo',
        scope: { extra: 1, kind: 'staged' },
        worktreePath: '/repo',
      });
      expect(result).toEqual({
        error: 'git-scope scope kind "staged" does not accept: extra',
        ok: false,
      });
    });

    it('rejects a missing repositoryRoot', () => {
      const result = validateChangeset({
        kind: 'git-scope',
        scope: { kind: 'staged' },
        worktreePath: '/repo',
      });
      expect(result).toEqual({
        error: 'changeset kind "git-scope" requires a non-empty repositoryRoot',
        ok: false,
      });
    });

    it('rejects a missing worktreePath', () => {
      const result = validateChangeset({
        kind: 'git-scope',
        repositoryRoot: '/repo',
        scope: { kind: 'staged' },
      });
      expect(result).toEqual({
        error: 'changeset kind "git-scope" requires a non-empty worktreePath',
        ok: false,
      });
    });

    it('rejects a non-object scope', () => {
      const result = validateChangeset({
        kind: 'git-scope',
        repositoryRoot: '/repo',
        scope: 'staged',
        worktreePath: '/repo',
      });
      expect(result).toEqual({
        error: 'git-scope changeset requires scope to be an object',
        ok: false,
      });
    });
  });
});

describe('validatePath', () => {
  it('accepts a non-empty string', () => {
    expect(validatePath('src/file.ts')).toEqual({ ok: true, value: 'src/file.ts' });
  });

  it('rejects a non-string path', () => {
    expect(validatePath(42)).toEqual({
      error: 'changes:fileDiff requires a non-empty path',
      ok: false,
    });
  });

  it('rejects an empty path', () => {
    expect(validatePath('')).toEqual({
      error: 'changes:fileDiff requires a non-empty path',
      ok: false,
    });
  });
});

describe('changes IPC handlers', () => {
  it('forwards a validated resolveView payload to the injected service', async () => {
    const service = fakeService();
    const handlers = createChangesIpcHandlers({ service });
    const changeset = { kind: 'agent-run', runId: 'r1', threadId: 't1' };

    const result = await handlers.resolveView('root-1', changeset);

    expect(result).toEqual({ ok: true, value: VIEW });
    expect(service.resolveView).toHaveBeenCalledWith('root-1', {
      kind: 'agent-run',
      runId: 'r1',
      threadId: 't1',
    });
  });

  it('forwards a validated fileDiff payload (changeset + path) to the injected service', async () => {
    const service = fakeService();
    const handlers = createChangesIpcHandlers({ service });
    const changeset = { kind: 'agent-run', runId: 'r1', threadId: 't1' };

    const result = await handlers.fileDiff('root-1', changeset, 'src/file.ts');

    expect(result).toEqual({ ok: true, value: DIFF });
    expect(service.fileDiff).toHaveBeenCalledWith(
      'root-1',
      { kind: 'agent-run', runId: 'r1', threadId: 't1' },
      'src/file.ts'
    );
  });

  it('rejects an invalid changeset before ever reaching the service', async () => {
    const service = fakeService();
    const handlers = createChangesIpcHandlers({ service });

    const result = await handlers.resolveView('root-1', { kind: 'bogus' });

    expect(result.ok).toBe(false);
    expect(service.resolveView).not.toHaveBeenCalled();
  });

  it('rejects an invalid path before ever reaching the service', async () => {
    const service = fakeService();
    const handlers = createChangesIpcHandlers({ service });
    const changeset = { kind: 'agent-run', runId: 'r1', threadId: 't1' };

    const result = await handlers.fileDiff('root-1', changeset, '');

    expect(result).toEqual({ error: 'changes:fileDiff requires a non-empty path', ok: false });
    expect(service.fileDiff).not.toHaveBeenCalled();
  });

  it('catches an unexpected service throw and returns a typed failure', async () => {
    const service = fakeService({
      resolveView: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const handlers = createChangesIpcHandlers({ service });

    const result = await handlers.resolveView('root-1', {
      kind: 'agent-run',
      runId: 'r1',
      threadId: 't1',
    });

    expect(result).toEqual({ error: 'boom', ok: false });
  });
});

describe('createChangesIpcHandlers.inventory (BST-1114 T0)', () => {
  const INVENTORY: GitInventory = {
    errors: ['repo /tmp/broken: fatal: not a git repository'],
    repositories: [
      {
        identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
        worktrees: [
          {
            bare: false,
            branch: 'main',
            containment: ['root-1'],
            current: true,
            detached: false,
            head: 'abc123',
            lockedReason: null,
            name: 'repo',
            path: '/repo',
            provenance: 'scanned',
            prunableReason: null,
            trust: 'validated',
            trustReason: null,
          },
        ],
      },
    ],
  };

  function fakeInventoryService(snapshot: GitInventory & { capturedAt: number }) {
    return {
      getSnapshot: vi.fn(async () => snapshot),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
  }

  it('projects the service snapshot onto the GitInventory wire contract', async () => {
    const service = fakeInventoryService({ ...INVENTORY, capturedAt: 1234 });
    const handlers = createChangesIpcHandlers({
      resolveInventoryService: () => service as never,
      service: fakeService() as never,
    });

    const result = await handlers.inventory();

    // `capturedAt` is a service-internal cache detail — it must NOT cross the
    // renderer boundary, and `errors` must survive intact (a repo failure is
    // reported, never dropped).
    expect(result).toEqual({ ok: true, value: INVENTORY });
    expect(result.ok && 'capturedAt' in result.value).toBe(false);
  });

  it('resolves the service LAZILY, per call', async () => {
    const service = fakeInventoryService({ ...INVENTORY, capturedAt: 1 });
    let current: ReturnType<typeof fakeInventoryService> | null = null;
    const handlers = createChangesIpcHandlers({
      resolveInventoryService: () => current as never,
      service: fakeService() as never,
    });

    // Registration happens before the service exists (the real main.ts
    // ordering): the first call must fail visibly...
    const before = await handlers.inventory();
    expect(before.ok).toBe(false);

    // ...and a later call, after app-ready construction, must succeed without
    // re-registering anything.
    current = service;
    const after = await handlers.inventory();
    expect(after).toEqual({ ok: true, value: INVENTORY });
  });

  it('reports an absent service as a visible failure, not an empty inventory', async () => {
    const handlers = createChangesIpcHandlers({ service: fakeService() as never });

    const result = await handlers.inventory();

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('git inventory service is not running');
  });

  it('catches a thrown getSnapshot (e.g. GitInventoryStoppedError) as a typed failure', async () => {
    const service = {
      getSnapshot: vi.fn(async () => {
        throw new Error('the service has been stopped');
      }),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const handlers = createChangesIpcHandlers({
      resolveInventoryService: () => service as never,
      service: fakeService() as never,
    });

    const result = await handlers.inventory();

    expect(result).toEqual({ error: 'the service has been stopped', ok: false });
  });

  // BST-1397: the renderer's post-registration nudge forces a rebuild through
  // this boundary, so `maxAgeMs` is now renderer-supplied and validated here.
  describe('maxAgeMs options bag', () => {
    function handlersWithSpy(): {
      getSnapshot: ReturnType<typeof vi.fn>;
      handlers: ReturnType<typeof createChangesIpcHandlers>;
    } {
      const service = fakeInventoryService({ ...INVENTORY, capturedAt: 7 });
      return {
        getSnapshot: service.getSnapshot,
        handlers: createChangesIpcHandlers({
          resolveInventoryService: () => service as never,
          service: fakeService() as never,
        }),
      };
    }

    it('passes a forced refresh through to the service', async () => {
      const { getSnapshot, handlers } = handlersWithSpy();

      await handlers.inventory({ maxAgeMs: 0 });

      expect(getSnapshot).toHaveBeenCalledWith({ maxAgeMs: 0 });
    });

    it('treats an omitted options bag as "no override"', async () => {
      const { getSnapshot, handlers } = handlersWithSpy();

      await handlers.inventory();

      expect(getSnapshot).toHaveBeenCalledWith({});
    });

    it.each([
      ['a non-object payload', 5],
      ['an array payload', []],
      ['a non-numeric maxAgeMs', { maxAgeMs: '0' }],
      ['a negative maxAgeMs', { maxAgeMs: -1 }],
      ['a fractional maxAgeMs', { maxAgeMs: 1.5 }],
      ['a non-finite maxAgeMs', { maxAgeMs: Number.NaN }],
      ['an unsupported key', { maxAgeMs: 0, refresh: true }],
    ])('rejects %s instead of coercing it', async (_label, options) => {
      const { getSnapshot, handlers } = handlersWithSpy();

      const result = await handlers.inventory(options);

      expect(result.ok).toBe(false);
      expect(getSnapshot).not.toHaveBeenCalled();
    });
  });
});
