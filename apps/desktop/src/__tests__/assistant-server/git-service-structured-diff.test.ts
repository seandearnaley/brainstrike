/**
 * Fake-runner unit coverage for `createGitService(...).structuredFileDiff`.
 *
 * Git itself is entirely faked here (see `createFakeRunner` below) — only the
 * WORKTREE-side reads (working mode's new side, untracked mode's only side)
 * touch the real filesystem, so those tests use a real temp directory. Real
 * end-to-end behavior against a real repo lives in
 * `git-service.integration.test.ts`.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { StructuredFileDiffParams } from '@brainstrike/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGitService,
  type GitCommandRun,
  type GitCommandRunner,
  STRUCTURED_DIFF_CONTENT_CAP_BYTES,
} from '../../assistant-server/git-service';

const createdRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'brainstrike-structured-diff-unit-')
  );
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

interface RecordedCall {
  readonly args: readonly string[];
  readonly binaryStdout: boolean | undefined;
}

/** Bare-minimum successful run; tests override only the fields they care about. */
function ok(overrides: Partial<GitCommandRun> = {}): GitCommandRun {
  return { exitCode: 0, stderr: '', stdout: '', timedOut: false, ...overrides };
}

/**
 * A completely fake `GitCommandRunner` dispatched by a caller-supplied router.
 * `invokeHookFree` (used for the mutation-free-but-hook-disabling unified diff
 * call) always probes `config --null --name-only --get-regexp ...` first —
 * answer that transparently ("no configured hooks") so every router below only
 * has to handle the invocations it actually cares about.
 */
function createFakeRunner(
  respond: (args: readonly string[], binaryStdout: boolean | undefined) => GitCommandRun
): { calls: RecordedCall[]; run: GitCommandRunner } {
  const calls: RecordedCall[] = [];
  const run: GitCommandRunner = ({ args, binaryStdout }) => {
    calls.push({ args, binaryStdout });
    if (args[0] === 'config' && args.includes('--get-regexp')) {
      return Promise.resolve(ok({ exitCode: 1 }));
    }
    return Promise.resolve(respond(args, binaryStdout));
  };
  return { calls, run };
}

// `invokeHookFree` prepends `-c core.fsmonitor=false -c core.hooksPath=...` to
// tracked-mode diff invocations, so `args[0]` is NOT reliably `'diff'` —
// match by inclusion instead of position.
function isNumstat(args: readonly string[]): boolean {
  return args.includes('diff') && args.includes('--numstat');
}

function isCatFile(args: readonly string[]): boolean {
  return args.includes('cat-file');
}

function isUnifiedDiff(args: readonly string[]): boolean {
  return args.includes('diff') && !args.includes('--numstat');
}

function isStatus(args: readonly string[]): boolean {
  return args.includes('status');
}

describe('structuredFileDiff — absent-side classification', () => {
  it('classifies an added file: old side (HEAD:path) absent, new side present', async () => {
    const cwd = await makeTempDir();
    const { calls, run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '3\t0\tadded.txt\0' });
      }
      if (isCatFile(args)) {
        const spec = args[2] ?? '';
        if (spec.startsWith('HEAD:')) {
          // HEAD:added.txt never existed.
          return ok({
            exitCode: 128,
            stderr: "fatal: path 'added.txt' does not exist in 'HEAD'\n",
          });
        }
        return ok({ exitCode: 0, stdoutBuffer: Buffer.from('a\nb\nc\n', 'utf8') });
      }
      if (isUnifiedDiff(args)) {
        return ok({
          stdout:
            'diff --git a/added.txt b/added.txt\nnew file mode 100644\n--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n',
        });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'staged', path: 'added.txt' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('added');
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: 'a\nb\nc\n',
      oldContent: null,
    });
    // New side for staged mode is read via `:0:<path>`, not the worktree.
    const catFileSpecs = calls.filter((c) => isCatFile(c.args)).map((c) => c.args[2]);
    expect(catFileSpecs).toContain('HEAD:added.txt');
  });
});

describe('structuredFileDiff — real-error vs absent classification (spike bug)', () => {
  it('surfaces a non-absent exit-128 stderr as ok:false, NOT an absent side', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '1\t1\tbroken.txt\0' });
      }
      if (isCatFile(args)) {
        // A real read failure whose stderr does NOT match any absent pattern —
        // must NOT be silently treated as "the file doesn't exist".
        return ok({
          exitCode: 128,
          stderr: 'fatal: unable to read sha1 file for permission-denied object\n',
        });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'staged', path: 'broken.txt' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/permission-denied/);
  });

  it('treats a maxBuffer overflow on a blob read as a hard failure, never a truncated success', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '1\t1\thuge.txt\0' });
      }
      if (isCatFile(args)) {
        return ok({
          exitCode: null,
          failureReason: 'maxBuffer',
          stderr: '',
          stdoutBuffer: Buffer.from('partial'),
        });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'staged', path: 'huge.txt' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/buffer/i);
  });
});

describe('structuredFileDiff — binary detection via stdoutBuffer null byte', () => {
  it('classifies content as binary when either present side contains a null byte', async () => {
    const cwd = await makeTempDir();
    const binaryBytes = Buffer.from([0x89, 0x50, 0x00, 0x47]);
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '-\t-\timage.png\0' });
      }
      if (isCatFile(args)) {
        const spec = args[2] ?? '';
        if (spec.startsWith('HEAD:')) {
          return ok({
            exitCode: 128,
            stderr: "fatal: path 'image.png' does not exist in 'HEAD'\n",
          });
        }
        return ok({ exitCode: 0, stdoutBuffer: binaryBytes });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'staged', path: 'image.png' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content).toEqual({ kind: 'binary' });
    expect(result.value.hunks).toEqual([]);
    expect(result.value.additions).toBeNull();
    expect(result.value.deletions).toBeNull();
  });

  it('classifies untracked binary content the same way, without any git cat-file call', async () => {
    const cwd = await makeTempDir();
    await fsPromises.writeFile(path.join(cwd, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
    const { calls, run } = createFakeRunner((args) => {
      throw new Error(`unexpected invocation for untracked mode: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'untracked', path: 'bin.dat' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content).toEqual({ kind: 'binary' });
    expect(result.value.status).toBe('untracked');
    expect(calls).toHaveLength(0);
  });
});

describe('structuredFileDiff — cap boundary', () => {
  it('a side exactly at the cap stays "full"', async () => {
    const cwd = await makeTempDir();
    const exact = 'a'.repeat(STRUCTURED_DIFF_CONTENT_CAP_BYTES);
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '1\t0\tbig.txt\0' });
      }
      if (isCatFile(args)) {
        const spec = args[2] ?? '';
        if (spec.startsWith('HEAD:')) {
          return ok({ exitCode: 128, stderr: "fatal: path 'big.txt' does not exist in 'HEAD'\n" });
        }
        return ok({ exitCode: 0, stdoutBuffer: Buffer.from(exact, 'utf8') });
      }
      if (isUnifiedDiff(args)) {
        return ok({ stdout: 'diff --git a/big.txt b/big.txt\n@@ -0,0 +1,1 @@\n+a\n' });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'staged', path: 'big.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content.kind).toBe('full');
  });

  it('one byte over the cap degrades to hunks-only with reason over-cap-new', async () => {
    const cwd = await makeTempDir();
    const overCap = 'a'.repeat(STRUCTURED_DIFF_CONTENT_CAP_BYTES + 1);
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '1\t0\tbig.txt\0' });
      }
      if (isCatFile(args)) {
        const spec = args[2] ?? '';
        if (spec.startsWith('HEAD:')) {
          return ok({ exitCode: 128, stderr: "fatal: path 'big.txt' does not exist in 'HEAD'\n" });
        }
        return ok({ exitCode: 0, stdoutBuffer: Buffer.from(overCap, 'utf8') });
      }
      if (isUnifiedDiff(args)) {
        return ok({ stdout: 'diff --git a/big.txt b/big.txt\n@@ -0,0 +1,1 @@\n+a\n' });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'staged', path: 'big.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content.kind).toBe('hunks-only');
    if (result.value.content.kind === 'hunks-only') {
      expect(result.value.content.reason).toBe('over-cap-new');
    }
    expect(result.value.hunks).toEqual([{ newLines: 1, newStart: 1, oldLines: 0, oldStart: 0 }]);
  });

  it('both sides over cap report reason over-cap-both', async () => {
    const cwd = await makeTempDir();
    const overCap = 'a'.repeat(STRUCTURED_DIFF_CONTENT_CAP_BYTES + 1);
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '1\t1\tbig.txt\0' });
      }
      if (isCatFile(args)) {
        return ok({ exitCode: 0, stdoutBuffer: Buffer.from(overCap, 'utf8') });
      }
      if (isUnifiedDiff(args)) {
        return ok({ stdout: 'diff --git a/big.txt b/big.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n' });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'staged', path: 'big.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content.kind).toBe('hunks-only');
    if (result.value.content.kind === 'hunks-only') {
      expect(result.value.content.reason).toBe('over-cap-both');
    }
  });
});

describe('structuredFileDiff — rename oldPath read routing', () => {
  it('routes the old-side read through oldPath, not the current path', async () => {
    const cwd = await makeTempDir();
    const { calls, run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '1\t1\t\0old.txt\0new.txt\0' });
      }
      if (isCatFile(args)) {
        const spec = args[2] ?? '';
        if (spec === 'HEAD:old.txt') {
          return ok({ exitCode: 0, stdoutBuffer: Buffer.from('line1\nline2\n', 'utf8') });
        }
        return ok({ exitCode: 0, stdoutBuffer: Buffer.from('line1\nline2-edited\n', 'utf8') });
      }
      if (isUnifiedDiff(args)) {
        expect(args).toEqual(expect.arrayContaining(['--', 'old.txt', 'new.txt']));
        return ok({
          stdout:
            'diff --git a/old.txt b/new.txt\nsimilarity index 50%\nrename from old.txt\nrename to new.txt\n@@ -1,2 +1,2 @@\n line1\n-line2\n+line2-edited\n',
        });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'staged', path: 'new.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('renamed');
    expect(result.value.oldPath).toBe('old.txt');
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: 'line1\nline2-edited\n',
      oldContent: 'line1\nline2\n',
    });
    const oldSideSpec = calls.find((c) => isCatFile(c.args) && c.args[2] === 'HEAD:old.txt');
    expect(oldSideSpec).toBeDefined();
    const newSideSpec = calls.find((c) => isCatFile(c.args) && c.args[2] === ':0:new.txt');
    expect(newSideSpec).toBeDefined();
  });
});

describe('structuredFileDiff — validation', () => {
  it('rejects unknown keys', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({
      extra: true,
      mode: 'staged',
      path: 'a.txt',
    } as unknown as StructuredFileDiffParams);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/extra/);
  });

  it('rejects an invalid mode', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({
      mode: 'bogus',
      path: 'a.txt',
    } as unknown as StructuredFileDiffParams);

    expect(result.ok).toBe(false);
  });
});

describe('structuredFileDiff — working mode zero-numstat-entries directs to untracked', () => {
  it('returns a directing error when the path is untracked, not a generic "no differences"', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '' });
      }
      if (isStatus(args)) {
        return ok({ stdout: '? new.txt\0' });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'working', path: 'new.txt' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/untracked/);
    expect(result.error).toMatch(/mode/);
  });

  it('returns the generic "no differences" error when the path is tracked and unchanged', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '' });
      }
      if (isStatus(args)) {
        return ok({ stdout: '' });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'working', path: 'unchanged.txt' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/no differences/);
  });

  it('staged mode with zero numstat entries never checks status, just reports no differences', async () => {
    const cwd = await makeTempDir();
    const { calls, run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '' });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'staged', path: 'unchanged.txt' });

    expect(result.ok).toBe(false);
    expect(calls.some((c) => isStatus(c.args))).toBe(false);
  });
});
