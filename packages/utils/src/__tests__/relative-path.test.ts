import { describe, expect, it } from 'vitest';
import { resolveRelativePath } from '../relative-path';

describe('resolveRelativePath', () => {
  it('resolves a sibling file', () => {
    expect(resolveRelativePath('/root/docs/readme.md', 'design.md')).toBe('/root/docs/design.md');
  });
  it('resolves ./ prefixed paths', () => {
    expect(resolveRelativePath('/root/docs/readme.md', './img/a.png')).toBe('/root/docs/img/a.png');
  });
  it('resolves ../ within bounds', () => {
    expect(resolveRelativePath('/root/docs/readme.md', '../src/main.ts')).toBe('/root/src/main.ts');
  });
  it('keeps the leading slash of absolute bases', () => {
    expect(resolveRelativePath('/a.md', 'b.md')).toBe('/b.md');
  });
  it('works with relative (web) base paths', () => {
    expect(resolveRelativePath('workspace/docs/readme.md', '../a.md')).toBe('workspace/a.md');
  });
  it('returns null when escaping above the root of the base path', () => {
    expect(resolveRelativePath('/root/readme.md', '../../etc/passwd')).toBeNull();
    expect(resolveRelativePath('docs/readme.md', '../../a.md')).toBeNull();
  });
  it('tolerates backslash separators in the relative segment', () => {
    expect(resolveRelativePath('/root/docs/readme.md', 'img\\a.png')).toBe('/root/docs/img/a.png');
  });
  it('collapses . segments and empty segments', () => {
    expect(resolveRelativePath('/root/docs/readme.md', './/./a.md')).toBe('/root/docs/a.md');
  });
});
