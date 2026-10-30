import { describe, expect, it } from 'vitest';
import { formatDiffLineComment } from '../diff-line-comment-to-thread';

const comment = {
  endLine: 12,
  lines: ['const answer = 42;'],
  side: 'modified',
  startLine: 12,
  text: 'Explain why it is 42.',
} as const;

describe('formatDiffLineComment', () => {
  it('names the file, its folder and the line, then quotes it above the comment', () => {
    expect(
      formatDiffLineComment({ comment, entry: { path: 'src/answer.ts' }, rootLabel: 'app' })
    ).toBe(
      [
        '`src/answer.ts` in app, line 12:',
        '```',
        'const answer = 42;',
        '```',
        'Explain why it is 42.',
      ].join('\n')
    );
  });

  it('gives a range its first and last line', () => {
    expect(
      formatDiffLineComment({
        comment: { ...comment, endLine: 14, lines: ['a', 'b', 'c'] },
        entry: { path: 'src/answer.ts' },
      })
    ).toMatch(/^`src\/answer\.ts`, lines 12–14:\n```\na\nb\nc\n```\n/u);
  });

  it('puts an old-side comment on the old version, under a rename its old path', () => {
    expect(
      formatDiffLineComment({
        comment: { ...comment, side: 'original' },
        entry: { oldPath: 'src/old-answer.ts', path: 'src/answer.ts' },
      })
    ).toMatch(/^`src\/old-answer\.ts`, line 12 of the old version:\n/u);
  });

  it('fences quoted lines that hold a fence of their own', () => {
    const text = formatDiffLineComment({
      comment: { ...comment, lines: ['```ts', 'x', '```'] },
      entry: { path: 'README.md' },
    });
    expect(text).toContain('\n````\n```ts\nx\n```\n````\n');
  });
});
