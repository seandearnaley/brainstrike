import { describe, expect, it } from 'vitest';
import { shortenPath } from '../collection-browser';

describe('shortenPath', () => {
  it('returns empty string for empty input', () => {
    expect(shortenPath('')).toBe('');
  });

  it('returns path unchanged if shorter than maxLength', () => {
    const shortPath = '/home/user/file.txt';
    expect(shortenPath(shortPath, 100)).toBe(shortPath);
  });

  it('replaces /Users/username with ~ on macOS paths', () => {
    const path = '/Users/john/Documents/projects/myapp/src/components/file.tsx';
    const result = shortenPath(path);
    expect(result.startsWith('~')).toBe(true);
    expect(result).not.toContain('/Users/john');
  });

  it('replaces /home/username with ~ on Linux paths', () => {
    const path = '/home/john/projects/myapp/src/components/deeply/nested/file.tsx';
    const result = shortenPath(path);
    expect(result.startsWith('~')).toBe(true);
    expect(result).not.toContain('/home/john');
  });

  it('replaces C:\\Users\\username with ~ on Windows paths', () => {
    const path = 'C:\\Users\\john\\Documents\\projects\\myapp\\src\\file.tsx';
    const result = shortenPath(path);
    expect(result.startsWith('~')).toBe(true);
    expect(result).not.toContain('C:\\Users\\john');
  });

  it('collapses middle segments when path is too long', () => {
    const path =
      '/Users/john/Documents/GitHub/very-long-project-name/src/components/deeply/nested/file.tsx';
    const result = shortenPath(path, 40);
    expect(result).toContain('…');
    // Should preserve filename and parent
    expect(result).toContain('nested');
    expect(result).toContain('file.tsx');
  });

  it('preserves last two path segments', () => {
    const path = '/Users/john/a/b/c/d/e/parent/filename.txt';
    const result = shortenPath(path, 30);
    expect(result).toContain('parent');
    expect(result).toContain('filename.txt');
  });

  it('uses correct separator for Windows paths', () => {
    const path = 'C:\\Users\\john\\very\\long\\deep\\nested\\path\\to\\file.tsx';
    const result = shortenPath(path, 30);
    expect(result).toContain('\\');
    expect(result).not.toContain('/');
  });

  it('uses correct separator for Unix paths', () => {
    const path = '/Users/john/very/long/deep/nested/path/to/file.tsx';
    const result = shortenPath(path, 30);
    expect(result).toContain('/');
    expect(result).not.toContain('\\');
  });

  it('handles paths with only a few segments gracefully', () => {
    const path = '/Users/john/file.txt';
    const result = shortenPath(path);
    // Short paths should be handled without error
    expect(result.length).toBeLessThanOrEqual(path.length);
  });

  it('respects custom maxLength parameter', () => {
    const path = '/Users/john/Documents/projects/file.tsx';
    const shortResult = shortenPath(path, 20);
    const longResult = shortenPath(path, 100);
    expect(shortResult.length).toBeLessThanOrEqual(longResult.length);
  });
});
