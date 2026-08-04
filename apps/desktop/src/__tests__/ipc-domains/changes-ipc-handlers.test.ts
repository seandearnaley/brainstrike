import type { Changeset, ChangesetView, GitResult, StructuredFileDiff } from '@brainstrike/types';
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
