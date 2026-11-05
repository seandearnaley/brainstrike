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
} from '../../src/git-workspace/changeset-git-scope.ts';
import type { GitCommandRun, GitCommandRunner } from '../../src/git-workspace/git-service.ts';

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

/** A `git diff` call; pinned output settings (`-c ...`) may precede the subcommand. */
function isDiff(args: readonly string[]): boolean {
  return args.includes('diff');
}

/** `git diff --raw -z` records: `[status, path]`, or `[status, oldPath, path]` for a rename. */
function raw(...records: (readonly string[])[]): string {
  const id = '0'.repeat(40);
  return records
    .map(([status = '', ...paths]) => {
      const modes = status === 'U' ? '000000 000000' : '100644 100644';
      return `:${modes} ${id} ${id} ${status}\0${paths.join('\0')}\0`;
    })
    .join('');
}

/** The unstaged scope's untracked files: none, in the repository's top folder. */
function noUntrackedFiles(args: readonly string[]): GitCommandRun | null {
  if (args.includes('status')) {
    return ok();
  }
  return args[0] === 'rev-parse' && args.includes('--show-prefix') ? ok({ stdout: '\n' }) : null;
}

interface RecordedCall {
  readonly args: readonly string[];
}

/**
 * A fake git whose folder is the top of its own work tree: it answers the
 * work-tree probe every git-scope call makes first, and `respond` the rest.
 */
function createFakeRunner(respond: (args: readonly string[]) => GitCommandRun): {
  calls: RecordedCall[];
  run: GitCommandRunner;
} {
  const calls: RecordedCall[] = [];
  const run: GitCommandRunner = ({ args, cwd }) => {
    if (args.includes('--is-inside-work-tree')) {
      return Promise.resolve(ok({ stdout: `true\n${cwd}\n` }));
    }
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
    expect(result.error.code).toBe('changeset.outside-roots');
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
      const untracked = noUntrackedFiles(args);
      if (untracked) {
        return untracked;
      }
      if (isDiff(args) && args.includes('--numstat')) {
        return ok({ stdout: '1\t0\ta.txt\0' });
      }
      if (isDiff(args) && args.includes('--raw')) {
        return ok({ stdout: raw(['M', 'a.txt']) });
      }
      if (isDiff(args)) {
        return ok({ stdout: 'diff --git a/a.txt b/a.txt\n@@ -1 +1,2 @@\n a\n+b\n' });
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

describe("resolveGitScopeChangesetView — each entry's patch", () => {
  async function viewOf(numstat: string, rawListing: string, patch: string) {
    const rootDir = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      const untracked = noUntrackedFiles(args);
      if (untracked) {
        return untracked;
      }
      if (isDiff(args) && args.includes('--numstat')) {
        return ok({ stdout: numstat });
      }
      if (isDiff(args) && args.includes('--raw')) {
        return ok({ stdout: rawListing });
      }
      if (isDiff(args)) {
        return ok({ stdout: patch });
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    });
    return await resolveGitScopeChangesetView(
      { resolveRootCwd: async () => ({ ok: true, value: rootDir }), run },
      'root-id',
      {
        kind: 'git-scope',
        repositoryRoot: rootDir,
        scope: { kind: 'unstaged' },
        worktreePath: rootDir,
      }
    );
  }

  it('matches sections to files by their paths, not their order, quoting names as git does', async () => {
    const quoted = 'diff --git "a/tab\\there" "b/tab\\there"\n@@ -1 +1 @@\n-a\n+b\n';
    const renamed =
      'diff --git a/old name.txt b/new name.txt\nsimilarity index 90%\nrename from old name.txt\nrename to new name.txt\n';
    const view = await viewOf(
      '1\t1\ttab\there\x000\t0\t\x00old name.txt\x00new name.txt\x00',
      raw(['M', 'tab\there'], ['R090', 'old name.txt', 'new name.txt']),
      `${renamed}${quoted}`
    );
    expect(view.ok).toBe(true);
    if (!view.ok) {
      return;
    }
    expect(view.value.files.map((file) => [file.path, file.patch])).toEqual([
      ['tab\there', quoted],
      ['new name.txt', renamed],
    ]);
  });

  it('a binary file draws no patch', async () => {
    const view = await viewOf(
      '-\t-\tlogo.png\x00',
      raw(['M', 'logo.png']),
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n'
    );
    expect(view.ok && view.value.files[0]?.patch).toBeNull();
  });

  it('fails visibly when a listed text file has no section, or a section has no listed file', async () => {
    const missing = await viewOf('1\t0\ta.txt\x00', raw(['M', 'a.txt']), '');
    expect(missing.ok).toBe(false);
    const stray = await viewOf(
      '1\t0\ta.txt\x00',
      raw(['M', 'a.txt']),
      'diff --git a/a.txt b/a.txt\n@@ -1 +1,2 @@\n a\n+b\ndiff --git a/b.txt b/b.txt\n@@ -1 +1 @@\n-x\n+y\n'
    );
    expect(stray.ok).toBe(false);
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
      if (isDiff(args)) {
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
      if (isDiff(args)) {
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
      if (isDiff(args)) {
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
    expect(result.error.code).toBe('changeset.base-ref-unresolved');
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
      if (args.includes('status')) {
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
    expect(result.error.code).toBe('changeset.head-unborn');
    expect(result.error.code).not.toBe('changeset.base-ref-unresolved');
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
      if (isDiff(args)) {
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
    const diffCalls = calls.filter((call) => isDiff(call.args));
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
    expect(result.error.message).toContain('sha512');
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
    expect(result.error.code).toBe('changeset.commit-id-unresolved');
  });
});

describe('listRefComparisonChanges — bidirectional numstat/raw merge (NTH-3)', () => {
  it('a numstat entry with NO matching raw entry is a visible error, not a silent drop', async () => {
    const { run } = createFakeRunner((args) => {
      if (isDiff(args) && args.includes('--numstat')) {
        return ok({ stdout: '1\t0\tonly-in-numstat.txt\0' });
      }
      if (isDiff(args) && args.includes('--raw')) {
        return ok({ stdout: '' });
      }
      if (isDiff(args)) {
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
    expect(result.error.message).toContain('only-in-numstat.txt');
  });

  it('a raw entry with NO matching numstat entry is a visible error, not a silent drop', async () => {
    const { run } = createFakeRunner((args) => {
      if (isDiff(args) && args.includes('--numstat')) {
        return ok({ stdout: '' });
      }
      if (isDiff(args) && args.includes('--raw')) {
        return ok({ stdout: raw(['M', 'only-in-raw.txt']) });
      }
      if (isDiff(args)) {
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
    expect(result.error.message).toContain('only-in-raw.txt');
  });
});

describe('listRefComparisonChanges — unmerged path (R3)', () => {
  it('an unmerged (U) path is a hard, dedicated "unmerged-path:" error naming the path', async () => {
    const { run } = createFakeRunner((args) => {
      if (isDiff(args) && args.includes('--numstat')) {
        return ok({ stdout: '0\t0\tconflict.txt\0' });
      }
      if (isDiff(args) && args.includes('--raw')) {
        return ok({ stdout: raw(['U', 'conflict.txt']) });
      }
      if (isDiff(args)) {
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
    expect(result.error.code).toBe('changeset.unmerged-path');
    expect(result.error.message).toContain('conflict.txt');
  });
});
