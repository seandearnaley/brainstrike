import { describe, expect, it } from 'vitest';
import {
  boundViewPatches,
  CHANGESET_VIEW_PATCH_BUDGET_BYTES,
  type DiffSide,
  diffGitHeader,
  fileDiffContent,
  PATCH_BOUND,
  splitPatchByFile,
} from '../../src/git-workspace/structured-diff-content.ts';
import { parsePatch } from './patch-test-support.ts';

const SMALL: DiffSide = { content: Buffer.from('a\n'), kind: 'present' };
const HEADER = 'diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n';

/** A hunk of `size` changed lines starting at old line `start`. */
function hunk(start: number, size: number, width = 20): string {
  const removed = Array.from({ length: size }, () => `-${'o'.repeat(width)}\n`).join('');
  const added = Array.from({ length: size }, () => `+${'n'.repeat(width)}\n`).join('');
  return `@@ -${start},${size} +${start},${size} @@\n${removed}${added}`;
}

describe('fileDiffContent — the patch always parses', () => {
  it("keeps a whole patch past the view's bound: a file's own diff carries every hunk", () => {
    const hunks = Array.from({ length: 30 }, (_, index) => hunk(index * 1000 + 1, 800));
    const text = `${HEADER}${hunks.join('')}`;
    expect(text.length).toBeGreaterThan(PATCH_BOUND);

    const content = fileDiffContent(SMALL, SMALL, { text, truncated: false });

    expect(content).toMatchObject({ kind: 'full', patch: text });
    expect(parsePatch(text).hunks).toBe(hunks.length);
  });

  it('cuts a capture the runner cut after its last whole hunk, keeping the header', () => {
    const hunks = Array.from({ length: 30 }, (_, index) => hunk(index * 1000 + 1, 80));
    const whole = `${HEADER}${hunks.join('')}`;
    const text = whole.slice(0, Math.floor(whole.length * 0.6));

    const content = fileDiffContent(SMALL, SMALL, { text, truncated: true });

    expect(content.kind).toBe('hunks-only');
    if (content.kind !== 'hunks-only') {
      return;
    }
    expect(content).toMatchObject({ patchTruncated: true, reason: 'diff-overflow' });
    expect(content.patch.startsWith(HEADER)).toBe(true);
    expect(whole.startsWith(content.patch)).toBe(true);
    expect(whole.slice(content.patch.length).startsWith('@@ ')).toBe(true);
    const parsed = parsePatch(content.patch);
    expect(parsed.hunks).toBeGreaterThan(0);
    expect(parsed.hunks).toBeLessThan(hunks.length);
  });

  it('drops the last hunk of a capture the runner cut, even a small one', () => {
    const whole = `${HEADER}${hunk(1, 2)}${hunk(50, 2)}`;
    const cut = whole.slice(0, whole.length - 7);

    const content = fileDiffContent(SMALL, SMALL, { text: cut, truncated: true });

    expect(content).toEqual({
      kind: 'hunks-only',
      patch: `${HEADER}${hunk(1, 2)}`,
      patchTruncated: true,
      reason: 'diff-overflow',
    });
  });

  it('a side over the cap keeps the whole patch it still fits', () => {
    const text = `${HEADER}${hunk(1, 1)}`;
    const content = fileDiffContent({ kind: 'over-cap', size: 9 }, SMALL, {
      text,
      truncated: false,
    });
    expect(content).toEqual({
      kind: 'hunks-only',
      patch: text,
      patchTruncated: false,
      reason: 'over-cap-old',
    });
  });

  it('binary is what git says, whatever the sides hold', () => {
    const text = 'diff --git a/x b/x\nBinary files a/x and b/x differ\n';
    expect(fileDiffContent(SMALL, SMALL, { text, truncated: false })).toEqual({ kind: 'binary' });
    const lookalike = `${HEADER}@@ -1 +1 @@\n-Binary files a and b differ\n+x\n`;
    expect(fileDiffContent(SMALL, SMALL, { text: lookalike, truncated: false }).kind).toBe('full');
  });
});

describe('boundViewPatches', () => {
  it('fills entries in order while the total fits; a later, smaller entry still fits', () => {
    const big = 'x'.repeat(PATCH_BOUND);
    const entries = [
      { patch: big },
      { patch: big },
      { patch: big },
      { patch: big },
      { patch: big },
      { patch: 'small' },
      { patch: null },
    ];
    const bounded = boundViewPatches(entries).map((entry) => entry.patch);
    const fitting = Math.floor(CHANGESET_VIEW_PATCH_BUDGET_BYTES / PATCH_BOUND);
    expect(bounded.slice(0, fitting)).toEqual(Array.from({ length: fitting }, () => big));
    expect(bounded.slice(fitting, 5)).toEqual(Array.from({ length: 5 - fitting }, () => null));
    expect(bounded.slice(5)).toEqual(['small', null]);
  });

  it('a patch over the per-file bound never goes in, even alone', () => {
    expect(boundViewPatches([{ patch: 'x'.repeat(PATCH_BOUND + 1) }])).toEqual([{ patch: null }]);
  });
});

describe('diffGitHeader', () => {
  it('quotes the way git does with core.quotePath=false', () => {
    expect(diffGitHeader('a b.txt', 'a b.txt')).toBe('diff --git a/a b.txt b/a b.txt');
    expect(diffGitHeader('naïve.txt', 'naïve.txt')).toBe('diff --git a/naïve.txt b/naïve.txt');
    expect(diffGitHeader('old.txt', 'tab\there')).toBe('diff --git a/old.txt "b/tab\\there"');
    expect(diffGitHeader('q"\\\u0001', 'x')).toBe('diff --git "a/q\\"\\\\\\001" b/x');
  });
});

describe('splitPatchByFile', () => {
  it("keeps a type change's two sections together and drops a cut capture's last section", () => {
    const deleted = 'diff --git a/t b/t\ndeleted file mode 100644\n@@ -1 +0,0 @@\n-a\n';
    const created = 'diff --git a/t b/t\nnew file mode 120000\n@@ -0,0 +1 @@\n+x\n';
    const other = 'diff --git a/u b/u\n@@ -1 +1 @@\n-a\n';
    expect([
      ...splitPatchByFile({ text: `${deleted}${created}${other}`, truncated: false }),
    ]).toEqual([
      ['diff --git a/t b/t', `${deleted}${created}`],
      ['diff --git a/u b/u', other],
    ]);
    expect([
      ...splitPatchByFile({ text: `${deleted}${created}${other}`, truncated: true }),
    ]).toEqual([['diff --git a/t b/t', `${deleted}${created}`]]);
  });

  it('drops both halves of a type change the cut lands in', () => {
    const deleted = 'diff --git a/t b/t\ndeleted file mode 120000\n@@ -1 +0,0 @@\n-x\n';
    const created = 'diff --git a/t b/t\nnew file mode 100644\n@@ -0,0 +1,9 @@\n+a\n+b';
    const other = 'diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n';
    expect([
      ...splitPatchByFile({ text: `${other}${deleted}${created}`, truncated: true }),
    ]).toEqual([['diff --git a/a b/a', other]]);
  });
});
