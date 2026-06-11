import { describe, expect, it } from 'vitest';
import { isAbsolutePath, toRelativePath } from '../paths';

describe('isAbsolutePath', () => {
  it('detects POSIX absolute paths', () => {
    expect(isAbsolutePath('/Users/dev/project/file.ts')).toBe(true);
  });

  it('detects Windows drive paths', () => {
    expect(isAbsolutePath('C:\\Users\\dev\\file.ts')).toBe(true);
    expect(isAbsolutePath('c:/Users/dev/file.ts')).toBe(true);
  });

  it('detects UNC paths', () => {
    expect(isAbsolutePath('\\\\server\\share\\file.ts')).toBe(true);
  });

  it('rejects relative paths (web file nodes)', () => {
    expect(isAbsolutePath('docs/notes.md')).toBe(false);
    expect(isAbsolutePath('notes.md')).toBe(false);
  });
});

describe('toRelativePath', () => {
  it('strips a POSIX root prefix', () => {
    expect(toRelativePath('/root/project/docs/notes.md', '/root/project')).toBe('docs/notes.md');
  });

  it('strips a root prefix that already ends with a separator', () => {
    expect(toRelativePath('/root/project/docs/notes.md', '/root/project/')).toBe('docs/notes.md');
  });

  it('strips a Windows root prefix', () => {
    expect(toRelativePath('C:\\proj\\docs\\notes.md', 'C:\\proj')).toBe('docs\\notes.md');
  });

  it('returns relative paths unchanged', () => {
    expect(toRelativePath('docs/notes.md', 'root-uuid')).toBe('docs/notes.md');
  });

  it('returns the absolute path unchanged when the root does not prefix it', () => {
    expect(toRelativePath('/elsewhere/file.ts', '/root/project')).toBe('/elsewhere/file.ts');
  });
});
