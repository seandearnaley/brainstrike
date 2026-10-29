/**
 * Fake-runner unit coverage for the `git-scope`-sourced `ChangesetDiffService`
 * half (BST-1113): segment-aware containment, base-ref resolution
 * (explicit/origin-HEAD/origin-main-probe/unresolved), and the
 * `branch-vs-base` → `range` mode params mapping (the 3a-review CRITICAL
 * finding: `range` must receive the MERGE-BASE, never the raw base ref).
 *
 * Real end-to-end behavior against real fixture repos (every scope's
 * listing, unborn HEAD, a root commit, a rename, a binary file, untracked
 * files) lives in `changeset-diff-service.integration.test.ts`.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GitScope } from '@brainstrike/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isPathContained,
  resolveGitScopeChangesetView,
  resolveGitScopeStructuredFileDiffParams,
} from '../../assistant-server/changeset-git-scope';
import type { GitCommandRun, GitCommandRunner } from '../../assistant-server/git-service';

const createdRoots: string[] = [];

/**
 * EVERY `args` array any `createFakeRunner` in this file ever recorded,
 * across every test — the `@{u}` invariant is asserted against this SHARED
 * log in a suite-wide `afterEach` (NTH-8, review finding) rather than in one
 * single test, so a future test that forgets to assert it locally still
 * gets the check for free.
 */
const allRecordedCalls: (readonly string[])[] = [];

afterEach(async () => {
  // NEVER `@{u}` — this upstream-tracking form must not appear in ANY git
  // invocation this module makes, in ANY test, not just the one that
  // exercises the base-ref-unresolved path.
  for (const args of allRecordedCalls) {
    expect(args.join(' ')).not.toContain('@{u}');
  }
  allRecordedCalls.length = 0;

  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

async function makeTempDir(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-changeset-git-scope-'));
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

function ok(overrides: Partial<GitCommandRun> = {}): GitCommandRun {
  return { exitCode: 0, stderr: '', stdout: '', timedOut: false, ...overrides };
}

interface RecordedCall {
  readonly args: readonly string[];
}

function createFakeRunner(respond: (args: readonly string[]) => GitCommandRun): {
  calls: RecordedCall[];
  run: GitCommandRunner;
} {
  const calls: RecordedCall[] = [];
  const run: GitCommandRunner = ({ args }) => {
    const recorded = [...args];
    calls.push({ args: recorded });
    allRecordedCalls.push(recorded);
    return Promise.resolve(respond(args));
  };
  return { calls, run };
}

describe('isPathContained — segment-aware prefix', () => {
  it('a sibling directory whose name is a PREFIX of the parent is NOT contained', () => {
    expect(isPathContained('/a/f', '/a/foo')).toBe(false);
  });

  it('a genuine descendant IS contained', () => {
    expect(isPathContained('/a', '/a/foo')).toBe(true);
  });

  it('the exact same path is contained', () => {
    expect(isPathContained('/a/foo', '/a/foo')).toBe(true);
  });

  it('a parent directory is NOT contained by its own child', () => {
    expect(isPathContained('/a/foo', '/a')).toBe(false);
  });

  it('an unrelated path is NOT contained', () => {
    expect(isPathContained('/a/foo', '/b/foo')).toBe(false);
  });
});

describe('resolveGitScopeChangesetView — containment', () => {
  it('outside-roots-unsupported when the resolved root does not contain the worktree', async () => {
    const rootDir = await makeTempDir();
    const outsideDir = await makeTempDir();
    const { run } = createFakeRunner(() => {
      throw new Error('git should never be invoked when containment fails');
    });
    const result = await resolveGitScopeChangesetView(
      { resolveRootCwd: async () => ({ ok: true, value: rootDir }), run },
      'root-id',
      {
        kind: 'git-scope',
        repositoryRoot: outsideDir,
        scope: { kind: 'uncommitted' },
        worktreePath: outsideDir,
      }
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/^outside-roots-unsupported:/u);
  });
});

describe('resolveGitScopeChangesetView — rootId validation (NTH-2)', () => {
  it('a non-string rootId is rejected WITHOUT ever calling resolveRootCwd or git', async () => {
    const rootDir = await makeTempDir();
    const result = await resolveGitScopeChangesetView(
      {
        resolveRootCwd: async () => {
          throw new Error('resolveRootCwd must never be called for a non-string rootId');
        },
        run: () => {
          throw new Error('git must never be invoked for a non-string rootId');
        },
      },
      12_345,
      {
        kind: 'git-scope',
        repositoryRoot: rootDir,
        scope: { kind: 'uncommitted' },
        worktreePath: rootDir,
      }
    );
    expect(result.ok).toBe(false);
  });

  it('a padded rootId is TRIMMED before reaching resolveRootCwd AND before landing in ChangedFileEntry.rootId', async () => {
    const rootDir = await makeTempDir();
    let receivedRootId: unknown;
    const { run } = createFakeRunner((args) => {
      if (args[0] === 'diff' && args.includes('--numstat')) {
        return ok({ stdout: '1\t0\ta.txt\0' });
      }
      if (args[0] === 'diff' && args.includes('--name-status')) {
        return ok({ stdout: 'M\x00a.txt\x00' });
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    });
    const result = await resolveGitScopeChangesetView(
      {
        resolveRootCwd: async (rootId) => {
          receivedRootId = rootId;
          return { ok: true, value: rootDir };
        },
        run,
      },
      '  root-id  ',
      {
        kind: 'git-scope',
        repositoryRoot: rootDir,
        scope: { kind: 'unstaged' },
        worktreePath: rootDir,
      }
    );
    expect(receivedRootId).toBe('root-id');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.files[0]?.rootId).toBe('root-id');
  });
});

const NO_HOOKS = ok({ exitCode: 1 });
const EMPTY_NUMSTAT = ok({ stdout: '' });

function isConfigHookProbe(args: readonly string[]): boolean {
  return args[0] === 'config' && args.includes('--get-regexp');
}

describe('resolveGitScopeChangesetView — branch-vs-base base-ref resolution', () => {
  it('an explicit baseRef wins — no origin/HEAD or origin/main probe is ever made', async () => {
    const { calls, run } = createFakeRunner((args) => {
      if (isConfigHookProbe(args)) {
        return NO_HOOKS;
      }
      if (args[0] === 'rev-parse' && args.includes('--verify') && args.includes('HEAD')) {
        return ok({ stdout: 'headsha\n' });
      }
      if (args[0] === 'merge-base') {
        return ok({ stdout: 'mergebasesha\n' });
      }
      if (args[0] === 'diff') {
        return EMPTY_NUMSTAT;
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    });
    const rootDir = await makeTempDir();
    const result = await resolveGitScopeChangesetView(
      { resolveRootCwd: async () => ({ ok: true, value: rootDir }), run },
      'root-id',
      {
        kind: 'git-scope',
        repositoryRoot: rootDir,
        scope: { baseRef: 'explicit-base', kind: 'branch-vs-base' },
        worktreePath: rootDir,
      }
    );
    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.args[0] === 'symbolic-ref')).toBe(false);
    const mergeBaseCall = calls.find((call) => call.args[0] === 'merge-base');
    expect(mergeBaseCall?.args).toEqual(['merge-base', 'explicit-base', 'HEAD']);
  });

  it('falls back to origin/HEAD via symbolic-ref when no explicit baseRef is given', async () => {
    const { calls, run } = createFakeRunner((args) => {
      if (args[0] === 'rev-parse' && args.includes('--verify') && args.includes('HEAD')) {
        return ok({ stdout: 'headsha\n' });
      }
      if (args[0] === 'symbolic-ref') {
        return ok({ stdout: 'refs/remotes/origin/main\n' });
      }
      if (args[0] === 'merge-base') {
        return ok({ stdout: 'mergebasesha\n' });
      }
      if (args[0] === 'diff') {
        return EMPTY_NUMSTAT;
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    });
    const rootDir = await makeTempDir();
    const result = await resolveGitScopeChangesetView(
      { resolveRootCwd: async () => ({ ok: true, value: rootDir }), run },
      'root-id',
      {
        kind: 'git-scope',
        repositoryRoot: rootDir,
        scope: { kind: 'branch-vs-base' },
        worktreePath: rootDir,
      }
    );
    expect(result.ok).toBe(true);
    const mergeBaseCall = calls.find((call) => call.args[0] === 'merge-base');
    expect(mergeBaseCall?.args).toEqual(['merge-base', 'origin/main', 'HEAD']);
  });

  it('falls back to an origin/main probe when symbolic-ref fails', async () => {
    const { calls, run } = createFakeRunner((args) => {
      if (args[0] === 'rev-parse' && args.includes('--verify') && args.includes('HEAD')) {
        return ok({ stdout: 'headsha\n' });
      }
      if (args[0] === 'symbolic-ref') {
        return ok({ exitCode: 1 });
      }
      if (
        args[0] === 'rev-parse' &&
        args.includes('--verify') &&
        args.includes('refs/remotes/origin/main')
      ) {
        return ok({ stdout: 'originmainsha\n' });
      }
      if (args[0] === 'merge-base') {
        return ok({ stdout: 'mergebasesha\n' });
      }
      if (args[0] === 'diff') {
        return EMPTY_NUMSTAT;
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    });
    const rootDir = await makeTempDir();
    const result = await resolveGitScopeChangesetView(
      { resolveRootCwd: async () => ({ ok: true, value: rootDir }), run },
      'root-id',
      {
        kind: 'git-scope',
        repositoryRoot: rootDir,
        scope: { kind: 'branch-vs-base' },
        worktreePath: rootDir,
      }
    );
    expect(result.ok).toBe(true);
    const mergeBaseCall = calls.find((call) => call.args[0] === 'merge-base');
    expect(mergeBaseCall?.args).toEqual(['merge-base', 'origin/main', 'HEAD']);
  });

  it('base-ref-unresolved when neither origin/HEAD nor origin/main resolve', async () => {
    const { run } = createFakeRunner((args) => {
      if (args[0] === 'rev-parse' && args.includes('--verify') && args.includes('HEAD')) {
        return ok({ stdout: 'headsha\n' });
      }
      if (args[0] === 'symbolic-ref') {
        return ok({ exitCode: 1 });
      }
      if (args[0] === 'rev-parse') {
        return ok({ exitCode: 1 });
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    });
    const rootDir = await makeTempDir();
    const result = await resolveGitScopeChangesetView(
      { resolveRootCwd: async () => ({ ok: true, value: rootDir }), run },
      'root-id',
      {
        kind: 'git-scope',
        repositoryRoot: rootDir,
        scope: { kind: 'branch-vs-base' },
        worktreePath: rootDir,
      }
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/^base-ref-unresolved:/u);
    // The `@{u}`-never invariant is asserted suite-wide in `afterEach` above.
  });
});

describe('resolveGitScopeStructuredFileDiffParams — branch-vs-base receives the merge-base, not the raw base ref', () => {
  it('the resolved "range" params carry the MERGE-BASE sha as baseRef', async () => {
    const invoke = async (args: readonly string[]): Promise<GitCommandRun> => {
      if (args[0] === 'rev-parse' && args.includes('--verify') && args.includes('HEAD')) {
        return ok({ stdout: 'headsha\n' });
      }
      if (args[0] === 'merge-base') {
        return ok({ stdout: 'the-real-merge-base-sha\n' });
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    };
    const scope: GitScope = { baseRef: 'raw-base-ref', kind: 'branch-vs-base' };
    const result = await resolveGitScopeStructuredFileDiffParams(invoke, scope, 'a.txt');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual({
      baseRef: 'the-real-merge-base-sha',
      mode: 'range',
      path: 'a.txt',
    });
    // The raw base ref must NEVER be the value handed to the engine.
    expect(result.value).not.toMatchObject({ baseRef: 'raw-base-ref' });
  });
});

describe("resolveGitScopeStructuredFileDiffParams — uncommitted's per-path untracked probe (the missing W3 assertion, folded into BST-1161)", () => {
  /** `git status --porcelain=v2 -z` + `rev-parse --show-prefix` (repo root). */
  function statusProbeInvoke(statusStdout: string) {
    return async (args: readonly string[]): Promise<GitCommandRun> => {
      if (args[0] === 'status') {
        expect(args).toContain('--untracked-files=all');
        return ok({ stdout: statusStdout });
      }
      if (args[0] === 'rev-parse' && args.includes('--show-prefix')) {
        return ok({ stdout: '\n' });
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    };
  }

  it("an untracked file in the uncommitted scope resolves { mode: 'untracked' } — the scope's ONLY untracked route", async () => {
    const invoke = statusProbeInvoke('? a.txt\0');
    const result = await resolveGitScopeStructuredFileDiffParams(
      invoke,
      { kind: 'uncommitted' },
      'a.txt'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual({ mode: 'untracked', path: 'a.txt' });
  });

  it("a tracked file in the uncommitted scope resolves { mode: 'working' } (HEAD vs worktree)", async () => {
    // The path is absent from the untracked set (an ordinary tracked edit).
    const invoke = statusProbeInvoke('');
    const result = await resolveGitScopeStructuredFileDiffParams(
      invoke,
      { kind: 'uncommitted' },
      'a.txt'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual({ mode: 'working', path: 'a.txt' });
  });
});

describe('resolveGitScopeStructuredFileDiffParams — unborn HEAD (NTH-1)', () => {
  it('an unborn HEAD is "head-unborn:", NEVER "base-ref-unresolved:" (the base ref is never even looked up)', async () => {
    const invoke = async (args: readonly string[]): Promise<GitCommandRun> => {
      if (args[0] === 'rev-parse' && args.includes('--verify') && args.includes('HEAD')) {
        // Unborn: HEAD does not resolve to a commit.
        return ok({ exitCode: 1 });
      }
      if (args[0] === 'rev-parse' && args.includes('--show-object-format')) {
        return ok({ stdout: 'sha1\n' });
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    };
    const scope: GitScope = { kind: 'branch-vs-base' };
    const result = await resolveGitScopeStructuredFileDiffParams(invoke, scope, 'a.txt');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/^head-unborn:/u);
    expect(result.error).not.toMatch(/^base-ref-unresolved:/u);
  });
});

const SHA256_EMPTY_TREE = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';
const SHA1_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

describe('empty-tree resolution — per-repo object format (review finding, BST-1113)', () => {
  it('a SHA-256 repo resolves the SHA-256 empty-tree id for an unborn-HEAD branch-vs-base, never the hardcoded SHA-1 constant', async () => {
    const { calls, run } = createFakeRunner((args) => {
      if (args[0] === 'rev-parse' && args.includes('--verify') && args.includes('HEAD')) {
        return ok({ exitCode: 1 });
      }
      if (args[0] === 'rev-parse' && args.includes('--show-object-format')) {
        return ok({ stdout: 'sha256\n' });
      }
      if (args[0] === 'diff') {
        return ok({ stdout: '' });
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    });
    const rootDir = await makeTempDir();
    const result = await resolveGitScopeChangesetView(
      { resolveRootCwd: async () => ({ ok: true, value: rootDir }), run },
      'root-id',
      {
        kind: 'git-scope',
        repositoryRoot: rootDir,
        scope: { kind: 'branch-vs-base' },
        worktreePath: rootDir,
      }
    );
    expect(result.ok).toBe(true);
    const diffCalls = calls.filter((call) => call.args[0] === 'diff');
    expect(diffCalls.length).toBeGreaterThan(0);
    for (const call of diffCalls) {
      expect(call.args).toContain(SHA256_EMPTY_TREE);
      expect(call.args).not.toContain(SHA1_EMPTY_TREE);
    }
  });

  it('an unresolvable object-format is a visible typed error, never a silent SHA-1 fallback', async () => {
    const invoke = async (args: readonly string[]): Promise<GitCommandRun> => {
      if (args[0] === 'rev-parse' && args.includes('--verify') && args.includes('HEAD')) {
        return ok({ exitCode: 1 });
      }
      if (args[0] === 'rev-parse' && args.includes('--show-object-format')) {
        return ok({ stdout: 'sha512\n' });
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    };
    const scope: GitScope = { kind: 'branch-vs-base' };
    const result = await resolveGitScopeStructuredFileDiffParams(invoke, scope, 'a.txt');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('sha512');
  });
});

describe('resolveGitScopeStructuredFileDiffParams — bogus commitId (NTH-9)', () => {
  it('an unresolvable/uppercase commitId is "commit-id-unresolved:", never a confusing downstream failure', async () => {
    const invoke = async (args: readonly string[]): Promise<GitCommandRun> => {
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        // Simulates git refusing to resolve a bogus/uppercase-hex rev.
        return ok({ exitCode: 128, stderr: "fatal: bad revision 'BOGUSCOMMITID^{commit}'\n" });
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    };
    const scope: GitScope = { commitId: 'BOGUSCOMMITID', kind: 'commit' };
    const result = await resolveGitScopeStructuredFileDiffParams(invoke, scope, 'a.txt');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/^commit-id-unresolved:/u);
  });
});

describe('listRefComparisonChanges — bidirectional numstat/name-status merge (NTH-3)', () => {
  it('a numstat entry with NO matching name-status entry is a visible error, not a silent drop', async () => {
    const { run } = createFakeRunner((args) => {
      if (args[0] === 'diff' && args.includes('--numstat')) {
        return ok({ stdout: '1\t0\tonly-in-numstat.txt\0' });
      }
      if (args[0] === 'diff' && args.includes('--name-status')) {
        return ok({ stdout: '' });
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    });
    const rootDir = await makeTempDir();
    const result = await resolveGitScopeChangesetView(
      { resolveRootCwd: async () => ({ ok: true, value: rootDir }), run },
      'root-id',
      {
        kind: 'git-scope',
        repositoryRoot: rootDir,
        scope: { kind: 'unstaged' },
        worktreePath: rootDir,
      }
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('only-in-numstat.txt');
  });

  it('a name-status entry with NO matching numstat entry is a visible error, not a silent drop', async () => {
    const { run } = createFakeRunner((args) => {
      if (args[0] === 'diff' && args.includes('--numstat')) {
        return ok({ stdout: '' });
      }
      if (args[0] === 'diff' && args.includes('--name-status')) {
        return ok({ stdout: 'M\x00only-in-namestatus.txt\x00' });
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    });
    const rootDir = await makeTempDir();
    const result = await resolveGitScopeChangesetView(
      { resolveRootCwd: async () => ({ ok: true, value: rootDir }), run },
      'root-id',
      {
        kind: 'git-scope',
        repositoryRoot: rootDir,
        scope: { kind: 'unstaged' },
        worktreePath: rootDir,
      }
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('only-in-namestatus.txt');
  });
});

describe('listRefComparisonChanges — unmerged path (R3)', () => {
  it('an unmerged (U) path is a hard, dedicated "unmerged-path:" error naming the path', async () => {
    const { run } = createFakeRunner((args) => {
      if (args[0] === 'diff' && args.includes('--numstat')) {
        return ok({ stdout: '0\t0\tconflict.txt\0' });
      }
      if (args[0] === 'diff' && args.includes('--name-status')) {
        return ok({ stdout: 'U\x00conflict.txt\x00' });
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    });
    const rootDir = await makeTempDir();
    const result = await resolveGitScopeChangesetView(
      { resolveRootCwd: async () => ({ ok: true, value: rootDir }), run },
      'root-id',
      {
        kind: 'git-scope',
        repositoryRoot: rootDir,
        scope: { kind: 'unstaged' },
        worktreePath: rootDir,
      }
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/^unmerged-path:/u);
    expect(result.error).toContain('conflict.txt');
  });
});
