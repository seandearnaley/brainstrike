import { describe, expect, it } from 'vitest';
import { isMarkdownPath } from '../is-markdown-path';

describe('isMarkdownPath', () => {
  it.each(['/a/readme.md', 'notes.markdown', 'a.mdown', 'b.mkd', 'UPPER.MD'])('accepts %s', (p) => {
    expect(isMarkdownPath(p)).toBe(true);
  });
  it.each(['component.mdx', 'main.ts', 'md', 'file.md.bak', 'a.txt'])('rejects %s', (p) => {
    expect(isMarkdownPath(p)).toBe(false);
  });
});
