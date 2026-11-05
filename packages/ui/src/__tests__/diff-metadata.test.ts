/**
 * ADR-0036: the renderer draws git's patch without diffing again. For any
 * edit git makes a patch of, the parsed diff counts the lines git counts, and
 * a commented line quotes exactly the file's text, before and after the full
 * sides arrive.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { actionHunks } from '@brainstrike/types';
import fc from 'fast-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  type DiffSide,
  FOLDED_LINES,
  lastChangedLine,
  parseFilePatch,
  sideLines,
} from '../diff-view/diff-metadata';

let repo = '';

function git(...args: string[]): string {
  return gitWithInput(undefined, ...args);
}

function gitWithInput(input: string | undefined, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: process.env['PATH'] },
    input,
  });
}

/** The lines a quote of `lines` 1–n reads, given which line numbers the diff holds. */
function quoted(lines: readonly string[], held: (line: number) => boolean): string[] {
  const result: string[] = [];
  let folded = false;
  lines.forEach((text, index) => {
    if (!held(index + 1)) {
      folded = result.length > 0;
      return;
    }
    if (folded) {
      result.push(FOLDED_LINES);
      folded = false;
    }
    result.push(text);
  });
  return result;
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'diff-metadata-'));
  git('init', '--quiet');
});

afterAll(() => {
  rmSync(repo, { force: true, recursive: true });
});

/** Lines from a small alphabet, so edits leave unchanged lines between hunks. */
const word = fc.constantFrom('alpha', 'beta', 'gamma', '', '  delta', 'eps;');

function textOf(lines: readonly string[], finalNewline: boolean): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}${finalNewline ? '\n' : ''}`;
}

const fileText = fc
  .record({ finalNewline: fc.boolean(), lines: fc.array(word, { maxLength: 40 }) })
  .map(({ finalNewline, lines }) => textOf(lines, finalNewline));

/** A file and a few edits to it, far enough apart that its patch often holds several hunks. */
const editedFile = fc
  .record({
    edits: fc.array(
      fc.record({ at: fc.nat(), kind: fc.constantFrom('delete', 'insert', 'replace'), text: word }),
      { maxLength: 4, minLength: 1 }
    ),
    finalNewline: fc.tuple(fc.boolean(), fc.boolean()),
    lines: fc.array(word, { maxLength: 60, minLength: 20 }),
  })
  .map(({ edits, finalNewline: [oldEnd, newEnd], lines }) => {
    const edited = [...lines];
    for (const { at, kind, text } of edits) {
      const index = at % (edited.length + 1);
      edited.splice(index, kind === 'insert' ? 0 : 1, ...(kind === 'delete' ? [] : [text]));
    }
    return [textOf(lines, oldEnd), textOf(edited, newEnd)] as const;
  });

/**
 * The line numbers of a hunk's last change, read from the hunk's own text:
 * its last run of added and removed lines, on each side.
 */
function lastChangeOf(hunk: string): Record<DiffSide, number[]> {
  const [, oldStart = '0', newStart = '0'] = /^@@ -(\d+)(?:,\d+)? \+(\d+)/u.exec(hunk) ?? [];
  let oldLine = Number(oldStart);
  let newLine = Number(newStart);
  let change: Record<DiffSide, number[]> = { additions: [], deletions: [] };
  let inChange = false;
  for (const line of hunk.split('\n').slice(1)) {
    const changed = line.startsWith('+') || line.startsWith('-');
    if (changed && !inChange) {
      change = { additions: [], deletions: [] };
    }
    inChange = changed || (inChange && line.startsWith('\\'));
    if (line.startsWith('+')) {
      change.additions.push(newLine++);
    } else if (line.startsWith('-')) {
      change.deletions.push(oldLine++);
    } else if (line.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
  }
  return change;
}

function linesOf(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/u, '').split('\n');
}

test('a parsed patch counts git’s lines and quotes the file’s text', () => {
  fc.assert(
    fc.property(fileText, fileText, (oldText, newText) => {
      fc.pre(oldText !== newText);
      writeFileSync(path.join(repo, 'f.txt'), oldText);
      git('add', 'f.txt');
      writeFileSync(path.join(repo, 'f.txt'), newText);
      const patch = git('diff', '--no-color', '--no-ext-diff', '-U3', '--', 'f.txt');
      const [added = '', deleted = ''] = git('diff', '--numstat', '--', 'f.txt').split('\t');

      const partial = parseFilePatch(patch);
      const full = parseFilePatch(patch, {
        newFile: { contents: newText, name: 'f.txt' },
        oldFile: { contents: oldText, name: 'f.txt' },
      });
      const oldLines = linesOf(oldText);
      const newLines = linesOf(newText);

      for (const fileDiff of [partial, full]) {
        const sum = (count: (hunk: (typeof fileDiff.hunks)[number]) => number) =>
          fileDiff.hunks.reduce((total, hunk) => total + count(hunk), 0);
        expect(sum((hunk) => hunk.additionLines)).toBe(Number(added));
        expect(sum((hunk) => hunk.deletionLines)).toBe(Number(deleted));
        for (const hunk of fileDiff.hunks) {
          for (
            let line = hunk.additionStart;
            line < hunk.additionStart + hunk.additionCount;
            line += 1
          ) {
            expect(sideLines(fileDiff, 'additions', line, line)).toEqual([newLines[line - 1]]);
          }
          for (
            let line = hunk.deletionStart;
            line < hunk.deletionStart + hunk.deletionCount;
            line += 1
          ) {
            expect(sideLines(fileDiff, 'deletions', line, line)).toEqual([oldLines[line - 1]]);
          }
        }
      }
      expect(sideLines(full, 'additions', 1, newLines.length)).toEqual(newLines);
      expect(sideLines(full, 'deletions', 1, oldLines.length)).toEqual(oldLines);
      // A range across folded lines quotes what the diff holds, with each fold marked.
      const holds = (side: 'additions' | 'deletions') => (line: number) =>
        partial.hunks.some((hunk) => {
          const first = side === 'additions' ? hunk.additionStart : hunk.deletionStart;
          const count = side === 'additions' ? hunk.additionCount : hunk.deletionCount;
          return line >= first && line < first + count;
        });
      expect(sideLines(partial, 'additions', 1, newLines.length)).toEqual(
        quoted(newLines, holds('additions'))
      );
      expect(sideLines(partial, 'deletions', 1, oldLines.length)).toEqual(
        quoted(oldLines, holds('deletions'))
      );
    }),
    { numRuns: 60 }
  );
});

test('a hunk’s actions sit on a line of its last change, with or without the full sides', () => {
  fc.assert(
    fc.property(editedFile, ([oldText, newText]) => {
      fc.pre(oldText !== newText);
      writeFileSync(path.join(repo, 'f.txt'), oldText);
      git('add', 'f.txt');
      writeFileSync(path.join(repo, 'f.txt'), newText);
      const patch = git('diff', '--no-color', '--no-ext-diff', '-U3', '--', 'f.txt');

      // The diff pairs each quoted hunk with the parsed hunk of its index.
      const hunks = actionHunks(patch) ?? [];
      const parsed = parseFilePatch(patch).hunks;
      expect(hunks.map((text) => text.slice(0, text.indexOf('\n') + 1))).toEqual(
        parsed.map((hunk) => hunk.hunkSpecs)
      );
      const full = parseFilePatch(patch, {
        newFile: { contents: newText, name: 'f.txt' },
        oldFile: { contents: oldText, name: 'f.txt' },
      }).hunks;
      for (const diffStyle of ['split', 'unified'] as const) {
        const ends = parsed.map((hunk) => lastChangedLine(hunk, diffStyle));
        expect(full.map((hunk) => lastChangedLine(hunk, diffStyle))).toEqual(ends);
        ends.forEach((end, index) => {
          expect(end).not.toBeNull();
          if (end) {
            expect(lastChangeOf(hunks[index] ?? '')[end.side]).toContain(end.lineNumber);
          }
        });
      }
    }),
    { numRuns: 60 }
  );
});

test('a file replaced by a symlink reads as one change with both sides', () => {
  writeFileSync(path.join(repo, 'link'), 'one\ntwo\n');
  git('add', 'link');
  git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '--quiet', '-m', 'file');
  const target = gitWithInput('../elsewhere', 'hash-object', '-w', '--stdin').trim();
  git('update-index', '--cacheinfo', `120000,${target},link`);
  const patch = git('diff', '--cached', '--no-color', '-U3', '--', 'link');
  expect(patch.match(/^diff --git /gmu)).toHaveLength(2);

  const fileDiff = parseFilePatch(patch);
  expect(fileDiff.type).toBe('change');
  expect(sideLines(fileDiff, 'deletions', 1, 2)).toEqual(['one', 'two']);
  expect(sideLines(fileDiff, 'additions', 1, 1)).toEqual(['../elsewhere']);
});

test('text that is not a file diff fails to parse', () => {
  expect(() => parseFilePatch('not a patch')).toThrow();
});
