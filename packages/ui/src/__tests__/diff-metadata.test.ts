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
import fc from 'fast-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { parseFilePatch, sideLines } from '../diff-view/diff-metadata';

let repo = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: process.env['PATH'] },
  });
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'diff-metadata-'));
  git('init', '--quiet');
});

afterAll(() => {
  rmSync(repo, { force: true, recursive: true });
});

/** Lines from a small alphabet, so edits leave unchanged lines between hunks. */
const fileText = fc
  .record({
    finalNewline: fc.boolean(),
    lines: fc.array(fc.constantFrom('alpha', 'beta', 'gamma', '', '  delta', 'eps;'), {
      maxLength: 40,
    }),
  })
  .map(({ finalNewline, lines }) =>
    lines.length === 0 ? '' : `${lines.join('\n')}${finalNewline ? '\n' : ''}`
  );

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
    }),
    { numRuns: 60 }
  );
});

test('text that is not a file diff fails to parse', () => {
  expect(() => parseFilePatch('not a patch')).toThrow();
});
