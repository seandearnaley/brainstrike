/**
 * Fake-runner unit coverage for `createGitService(...).structuredFileDiff`.
 *
 * Git itself is entirely faked here (see `createFakeRunner` below) — only the
 * WORKTREE-side reads (working mode's new side, untracked mode's only side)
 * touch the real filesystem, so those tests use a real temp directory. Real
 * end-to-end behavior against a real repo lives in
 * `git-service.integration.test.ts`.
 *
 * PATH SPACE: every `cat-file` spec below uses the `:./<path>` magic
 * pathspec form (`HEAD:./x`, `:0:./x`) — see `git-structured-diff.ts`'s
 * module doc comment. `readRefBlob` now size-PROBES (`cat-file -s <spec>`)
 * before ever reading a blob, so a fake router branch on a spec generally
 * needs to answer BOTH the probe (`args.includes('-s')`) and the actual
 * `blob` read — EXCEPT for an absent/unmerged/over-cap side, where the probe
 * alone determines the outcome and the `blob` sub-command is never invoked
 * at all (a router with no matching branch for it will throw "unexpected
 * invocation" if that invariant is ever violated).
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
} from '../../src/git-workspace/git-service.ts';
import { STRUCTURED_DIFF_CONTENT_CAP_BYTES } from '../../src/git-workspace/git-structured-diff.ts';

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
 * Two invocations are transparently answered before reaching the router, so
 * every test only has to handle the invocations it actually cares about:
 * - `invokeHookFree`'s `config --null --name-only --get-regexp ...` hook
 *   probe ("no configured hooks").
 * - `isPathUntracked`'s `rev-parse --show-prefix` (empty prefix — cwd IS the
 *   repo root; the non-empty-prefix / sub-root case is exercised at the
 *   integration level with a real repo, since it needs real git path-space
 *   behavior, not a faked one).
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
    if (args[0] === 'rev-parse' && args.includes('--show-prefix')) {
      return Promise.resolve(ok({ stdout: '' }));
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

function isCatFileSizeProbe(args: readonly string[]): boolean {
  return args.includes('cat-file') && args.includes('-s');
}

function isUnifiedDiff(args: readonly string[]): boolean {
  return args.includes('diff') && !args.includes('--numstat');
}

function isStatus(args: readonly string[]): boolean {
  return args.includes('status');
}

/** Absent-side response: the SIZE PROBE itself fails, so the actual `blob`
 * read is never reached at all. */
function absentSpec(path_: string, atRef: 'HEAD' | 'index' = 'HEAD'): GitCommandRun {
  return atRef === 'HEAD'
    ? ok({ exitCode: 128, stderr: `fatal: path '${path_}' does not exist in 'HEAD'\n` })
    : ok({
        exitCode: 128,
        stderr: `fatal: path '${path_}' does not exist (neither on disk nor in the index)\n`,
      });
}

/** Present-side response for a given spec: answers the size probe with the
 * real byte length, then the blob read with the actual content. */
function presentSpec(args: readonly string[], content: Buffer): GitCommandRun {
  return isCatFileSizeProbe(args)
    ? ok({ stdout: `${content.byteLength}\n` })
    : ok({ exitCode: 0, stdoutBuffer: content });
}

describe('structuredFileDiff — absent-side classification', () => {
  it('classifies an added file: old side (HEAD:./path) absent, new side present', async () => {
    const cwd = await makeTempDir();
    const newContent = Buffer.from('a\nb\nc\n', 'utf8');
    const { calls, run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '3\t0\tadded.txt\0' });
      }
      if (isCatFile(args)) {
        const spec = args.at(-1) ?? '';
        if (spec === 'HEAD:./added.txt') {
          return absentSpec('added.txt');
        }
        return presentSpec(args, newContent);
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
    // New side for staged mode is read via `:0:./<path>`, not the worktree.
    const catFileCalls = calls.filter((c) => isCatFile(c.args));
    expect(catFileCalls.map((c) => c.args.at(-1))).toContain('HEAD:./added.txt');
    expect(catFileCalls.map((c) => c.args.at(-1))).toContain(':0:./added.txt');
    // Only the actual blob READ requests raw bytes — the `-s` size probe is
    // plain decimal text.
    const blobReads = catFileCalls.filter((c) => c.args.includes('blob'));
    expect(blobReads.length).toBeGreaterThan(0);
    for (const call of blobReads) {
      expect(call.binaryStdout).toBe(true);
    }
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
        // A real read failure whose stderr does NOT match any absent or
        // unmerged pattern — must NOT be silently treated as "the file
        // doesn't exist". The SIZE PROBE fails this way, so the blob read
        // is never reached.
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
    expect(result.error.message).toMatch(/permission-denied/u);
  });

  it('treats a maxBuffer overflow on the ACTUAL blob read as a hard failure, never a truncated success', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '1\t1\thuge.txt\0' });
      }
      if (isCatFile(args)) {
        if (isCatFileSizeProbe(args)) {
          // Probe reports a safe size, so the code proceeds to the actual
          // read — which then unexpectedly overflows (e.g. a concurrent
          // write grew the blob between the probe and the read).
          return ok({ stdout: '10\n' });
        }
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
    expect(result.error.message).toMatch(/buffer/iu);
  });

  it('surfaces ok:false, never a fabricated empty blob, when the runner returns no stdoutBuffer on a clean exit', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '1\t0\tnobuf.txt\0' });
      }
      if (isCatFile(args)) {
        const spec = args.at(-1) ?? '';
        if (spec === 'HEAD:./nobuf.txt') {
          return absentSpec('nobuf.txt');
        }
        if (isCatFileSizeProbe(args)) {
          return ok({ stdout: '1\n' });
        }
        // Contract violation: binaryStdout was requested and the exit is
        // clean, but the runner didn't populate stdoutBuffer at all.
        return ok({ exitCode: 0 });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'staged', path: 'nobuf.txt' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/no buffer/iu);
    expect(result.error.message).toContain('nobuf.txt');
  });
});

describe('structuredFileDiff — unmerged stage-0 (real merge conflict) classification', () => {
  it('surfaces ok:false naming the path, never status "deleted", when the new side has no stage-0 entry', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '4\t0\tconflict.txt\0' });
      }
      if (isCatFile(args)) {
        const spec = args.at(-1) ?? '';
        if (spec === 'HEAD:./conflict.txt') {
          return presentSpec(args, Buffer.from('from main\n', 'utf8'));
        }
        // :0:./conflict.txt — mid-merge-conflict, no stage-0 entry.
        return ok({
          exitCode: 128,
          stderr: "fatal: path 'conflict.txt' is in the index, but not at stage 0\n",
        });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'staged', path: 'conflict.txt' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/unmerged path/u);
    expect(result.error.message).toMatch(/resolve merge conflicts/u);
    expect(result.error.message).toContain('conflict.txt');
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
        const spec = args.at(-1) ?? '';
        if (spec === 'HEAD:./image.png') {
          return absentSpec('image.png');
        }
        return presentSpec(args, binaryBytes);
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

  it('classifies untracked binary content the same way, without any git invocation at all', async () => {
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

describe('structuredFileDiff — cap boundary (size-probed, never over-reading a blob)', () => {
  it('a side exactly at the cap stays "full"', async () => {
    const cwd = await makeTempDir();
    const exact = Buffer.from('a'.repeat(STRUCTURED_DIFF_CONTENT_CAP_BYTES), 'utf8');
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '1\t0\tbig.txt\0' });
      }
      if (isCatFile(args)) {
        const spec = args.at(-1) ?? '';
        if (spec === 'HEAD:./big.txt') {
          return absentSpec('big.txt');
        }
        return presentSpec(args, exact);
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

  it('one byte over the cap degrades to hunks-only with reason over-cap-new, WITHOUT ever reading the blob', async () => {
    const cwd = await makeTempDir();
    const { calls, run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '1\t0\tbig.txt\0' });
      }
      if (isCatFile(args)) {
        const spec = args.at(-1) ?? '';
        if (spec === 'HEAD:./big.txt') {
          return absentSpec('big.txt');
        }
        // New side: the size probe alone reports over-cap — no buffer needed.
        return ok({ stdout: `${STRUCTURED_DIFF_CONTENT_CAP_BYTES + 1}\n` });
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
    // The size probe determined "over cap" alone — the `blob` sub-command
    // must never have been invoked for the new side.
    expect(calls.some((c) => isCatFile(c.args) && c.args.includes('blob'))).toBe(false);
  });

  it('both sides over cap report reason over-cap-both, WITHOUT ever reading either blob', async () => {
    const cwd = await makeTempDir();
    const { calls, run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '1\t1\tbig.txt\0' });
      }
      if (isCatFile(args)) {
        return ok({ stdout: `${STRUCTURED_DIFF_CONTENT_CAP_BYTES + 1}\n` });
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
    expect(calls.some((c) => isCatFile(c.args) && c.args.includes('blob'))).toBe(false);
  });

  it('only the old side over cap reports reason over-cap-old', async () => {
    const cwd = await makeTempDir();
    const smallContent = Buffer.from('small\n', 'utf8');
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '0\t1\tbig.txt\0' });
      }
      if (isCatFile(args)) {
        const spec = args.at(-1) ?? '';
        if (spec === 'HEAD:./big.txt') {
          return ok({ stdout: `${STRUCTURED_DIFF_CONTENT_CAP_BYTES + 1}\n` });
        }
        return presentSpec(args, smallContent);
      }
      if (isUnifiedDiff(args)) {
        return ok({ stdout: 'diff --git a/big.txt b/big.txt\n@@ -1,1 +1,1 @@\n-a\n+small\n' });
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
      expect(result.value.content.reason).toBe('over-cap-old');
    }
  });
});

describe('structuredFileDiff — a maxBuffer overflow on the diff invocation forces hunks-only', () => {
  it('never claims full content with short/wrong hunks when the unified diff itself overflows, even though both sides are small', async () => {
    const cwd = await makeTempDir();
    // Real, over 1MB (GIT_MAX_OUTPUT_BYTES) so boundOutput's own truncation
    // actually engages — the guarantee parseHunkHeaders relies on (a clean,
    // marker-terminated prefix) only holds once boundOutput has truncated.
    // The one real hunk header appears well before the cut, so it survives
    // intact; only the trailing filler content past it gets cut.
    const hugeDiffText = `diff --git a/small.txt b/small.txt\n@@ -1,1 +1,1 @@\n-a\n+${'x'.repeat(1_100_000)}\n`;
    const { run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        return ok({ stdout: '1\t1\tsmall.txt\0' });
      }
      if (isCatFile(args)) {
        const spec = args.at(-1) ?? '';
        if (spec === 'HEAD:./small.txt') {
          return presentSpec(args, Buffer.from('a\n', 'utf8'));
        }
        return presentSpec(args, Buffer.from('b\n', 'utf8'));
      }
      if (isUnifiedDiff(args)) {
        // Both sides are trivially small (2 bytes each), but the DIFF
        // INVOCATION ITSELF overflowed git's output buffer — the exact
        // scenario `diffFailure` treats as a non-failure text
        // "success" (a raw execFile maxBuffer kill has exitCode null).
        return ok({
          exitCode: null,
          failureReason: 'maxBuffer',
          stdout: hugeDiffText,
        });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'staged', path: 'small.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Never 'full' with silently-short hunks — always an honest hunks-only.
    expect(result.value.content.kind).toBe('hunks-only');
    if (result.value.content.kind !== 'hunks-only') {
      return;
    }
    expect(result.value.content.hunkTextTruncated).toBe(true);
    expect(result.value.content.hunkText).toContain('…(output truncated)');
    // Neither side individually crossed the per-file cap — the diff overflow
    // itself is the (honest) reason, not a guess at which side is "over cap".
    expect(result.value.content.reason).toBe('diff-overflow');
    // The one hunk header that appeared before the cut point still parses.
    expect(result.value.hunks).toEqual([{ newLines: 1, newStart: 1, oldLines: 1, oldStart: 1 }]);
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
        const spec = args.at(-1) ?? '';
        if (spec === 'HEAD:./old.txt') {
          return presentSpec(args, Buffer.from('line1\nline2\n', 'utf8'));
        }
        return presentSpec(args, Buffer.from('line1\nline2-edited\n', 'utf8'));
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
    const oldSideSpec = calls.find((c) => isCatFile(c.args) && c.args.at(-1) === 'HEAD:./old.txt');
    expect(oldSideSpec).toBeDefined();
    const newSideSpec = calls.find((c) => isCatFile(c.args) && c.args.at(-1) === ':0:./new.txt');
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
    expect(result.error.message).toMatch(/extra/u);
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

const VALID_COMMIT_ID = 'a'.repeat(40);

describe('structuredFileDiff — commit/range validation (BST-1113)', () => {
  it('rejects baseRef supplied on mode "commit"', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({
      baseRef: 'origin/main',
      commitId: VALID_COMMIT_ID,
      mode: 'commit',
      path: 'a.txt',
    } as unknown as StructuredFileDiffParams);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/baseRef/u);
    expect(result.error.message).toMatch(/commit/u);
  });

  it('rejects commitId supplied on mode "range"', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({
      baseRef: 'origin/main',
      commitId: VALID_COMMIT_ID,
      mode: 'range',
      path: 'a.txt',
    } as unknown as StructuredFileDiffParams);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/commitId/u);
    expect(result.error.message).toMatch(/range/u);
  });

  it('rejects a missing commitId on mode "commit"', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({
      mode: 'commit',
      path: 'a.txt',
    } as unknown as StructuredFileDiffParams);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/commitId/u);
  });

  it('rejects an empty-string commitId on mode "commit"', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({
      commitId: '',
      mode: 'commit',
      path: 'a.txt',
    } as unknown as StructuredFileDiffParams);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/commitId/u);
  });

  it('rejects a commitId that is not a full git object id', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({
      commitId: 'not-a-sha',
      mode: 'commit',
      path: 'a.txt',
    } as unknown as StructuredFileDiffParams);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/full object id/u);
  });

  it('rejects a commitId starting with "-" (never let a ref be read as a git option), WITHOUT ever invoking git', async () => {
    const cwd = await makeTempDir();
    const { calls, run } = createFakeRunner((args) => {
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({
      commitId: `-${'a'.repeat(39)}`,
      mode: 'commit',
      path: 'a.txt',
    } as unknown as StructuredFileDiffParams);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/commitId/u);
    expect(result.error.message).toMatch(/-/u);
    expect(calls).toHaveLength(0);
  });

  it('rejects a baseRef starting with "-", WITHOUT ever invoking git', async () => {
    const cwd = await makeTempDir();
    const { calls, run } = createFakeRunner((args) => {
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({
      baseRef: '--upload-pack=evil',
      mode: 'range',
      path: 'a.txt',
    } as unknown as StructuredFileDiffParams);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/baseRef/u);
    expect(calls).toHaveLength(0);
  });

  it('rejects a baseRef containing whitespace', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({
      baseRef: 'origin main',
      mode: 'range',
      path: 'a.txt',
    } as unknown as StructuredFileDiffParams);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/baseRef/u);
  });

  it('rejects a baseRef containing ":" (would corrupt the "<ref>:./<path>" spec form)', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({
      baseRef: 'origin:main',
      mode: 'range',
      path: 'a.txt',
    } as unknown as StructuredFileDiffParams);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/baseRef/u);
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
    expect(result.error.message).toMatch(/untracked/u);
    expect(result.error.message).toMatch(/mode/u);
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
    expect(result.error.message).toMatch(/no differences/u);
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

describe('structuredFileDiff — "unstaged" mode (BST-1113 review finding)', () => {
  it('is accepted by validation with only mode/path, mirroring staged/working', async () => {
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

    const result = await service.structuredFileDiff({ mode: 'unstaged', path: 'x.txt' });

    // Reaches the SAME "no differences" outcome staged/working would for an
    // unchanged path — i.e. the mode is recognized and routed, not rejected
    // as unsupported.
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/no differences/u);
  });

  it('rejects an unsupported extra key on mode "unstaged"', async () => {
    const cwd = await makeTempDir();
    const { run } = createFakeRunner((args) => {
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({
      commitId: 'a'.repeat(40),
      mode: 'unstaged',
      path: 'x.txt',
    } as unknown as StructuredFileDiffParams);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/commitId/u);
    expect(result.error.message).toMatch(/unstaged/u);
  });

  it('reads the OLD side from the INDEX (:0:./<path>), never HEAD — the review-fixed bug', async () => {
    const cwd = await makeTempDir();
    const oldContent = Buffer.from('index-side\n', 'utf8');
    const newContent = Buffer.from('worktree-side\n', 'utf8');
    await fsPromises.writeFile(path.join(cwd, 'x.txt'), newContent);
    const { calls, run } = createFakeRunner((args) => {
      if (isNumstat(args)) {
        // `unstaged`'s numstat target is `[]` (no ref args) — index vs
        // worktree, the SAME comparison `unstaged`'s own scope LISTING uses.
        return ok({ stdout: '1\t1\tx.txt\0' });
      }
      if (isCatFile(args)) {
        // Old side MUST be the index (`:0:./x.txt`), never `HEAD:./x.txt`.
        if (args.some((arg) => arg.includes('HEAD:'))) {
          throw new Error(`unstaged mode must never read HEAD: ${args.join(' ')}`);
        }
        return presentSpec(args, oldContent);
      }
      if (isUnifiedDiff(args)) {
        return ok({ stdout: '' });
      }
      throw new Error(`unexpected invocation: ${args.join(' ')}`);
    });
    const service = createGitService({ cwd, run });

    const result = await service.structuredFileDiff({ mode: 'unstaged', path: 'x.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: 'worktree-side\n',
      oldContent: 'index-side\n',
    });
    expect(calls.some((call) => call.args.some((arg) => arg.includes(':0:./x.txt')))).toBe(true);
  });
});
