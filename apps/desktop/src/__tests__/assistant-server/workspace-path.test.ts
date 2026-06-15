import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  isHiddenPath,
  isWithinRoot,
  joinSegments,
  normalizeWorkspacePath,
  normalizeWorkspacePaths,
  toPathSegments,
} from '../../assistant-server/workspace-path';

describe('workspace-path: normalizeWorkspacePath', () => {
  it('collapses bare ".", "", "./" and whitespace to the root "/"', () => {
    expect(normalizeWorkspacePath('.')).toBe('/');
    expect(normalizeWorkspacePath('')).toBe('/');
    expect(normalizeWorkspacePath('./')).toBe('/');
    expect(normalizeWorkspacePath('   ')).toBe('/');
    expect(normalizeWorkspacePath('/')).toBe('/');
    expect(normalizeWorkspacePath('//')).toBe('/');
  });

  it('preserves the caller rooting convention (rooted stays rooted, relative stays relative)', () => {
    expect(normalizeWorkspacePath('/src/main.ts')).toBe('/src/main.ts');
    expect(normalizeWorkspacePath('src/main.ts')).toBe('src/main.ts');
  });

  it('strips a single leading "./" prefix', () => {
    expect(normalizeWorkspacePath('./src/main.ts')).toBe('src/main.ts');
  });

  it('converts Windows backslashes and mixed separators to forward slashes', () => {
    expect(normalizeWorkspacePath('src\\lib\\math.ts')).toBe('src/lib/math.ts');
    expect(normalizeWorkspacePath('src\\lib/math.ts')).toBe('src/lib/math.ts');
    expect(normalizeWorkspacePath('\\src\\main.ts')).toBe('/src/main.ts');
  });

  it('collapses duplicate slashes (so selection keys stay stable across OSes)', () => {
    expect(normalizeWorkspacePath('foo//bar')).toBe('foo/bar');
    expect(normalizeWorkspacePath('/foo///bar')).toBe('/foo/bar');
    expect(normalizeWorkspacePath('foo\\\\bar')).toBe('foo/bar');
  });

  it('collapses interior "." segments (so they are not mistaken for hidden paths)', () => {
    expect(normalizeWorkspacePath('foo/./bar')).toBe('foo/bar');
    expect(normalizeWorkspacePath('./foo/./bar/.')).toBe('foo/bar');
  });

  it('strips trailing slashes (except the root)', () => {
    expect(normalizeWorkspacePath('foo/')).toBe('foo');
    expect(normalizeWorkspacePath('/foo/bar/')).toBe('/foo/bar');
  });

  it('clamps ".." so a virtual path can never escape the workspace root', () => {
    // Relative inputs stay relative; ".." that would escape collapses to root.
    expect(normalizeWorkspacePath('foo/../bar')).toBe('bar');
    expect(normalizeWorkspacePath('../bar')).toBe('bar');
    expect(normalizeWorkspacePath('../../../etc/passwd')).toBe('etc/passwd');
    expect(normalizeWorkspacePath('..')).toBe('/');
    // Rooted inputs stay rooted and clamp at "/".
    expect(normalizeWorkspacePath('/foo/../../etc')).toBe('/etc');
    expect(normalizeWorkspacePath('/..')).toBe('/');
  });
});

describe('workspace-path: normalizeWorkspacePaths', () => {
  it('normalizes, drops empties, and de-duplicates equivalent paths', () => {
    expect(
      normalizeWorkspacePaths(['src/main.ts', 'src//main.ts', './src/main.ts', '   '])
    ).toEqual(['src/main.ts']);
  });

  it('treats a bare "." as the root entry', () => {
    expect(normalizeWorkspacePaths(['.'])).toEqual(['/']);
  });
});

describe('workspace-path: toPathSegments', () => {
  it('splits on "/" and drops the leading slash and empty segments', () => {
    expect(toPathSegments('/src/main.ts')).toEqual(['src', 'main.ts']);
    expect(toPathSegments('src/main.ts')).toEqual(['src', 'main.ts']);
    expect(toPathSegments('/')).toEqual([]);
    expect(toPathSegments('//foo//bar//')).toEqual(['foo', 'bar']);
  });
});

describe('workspace-path: joinSegments', () => {
  it('joins base and child segments into a single rooted path', () => {
    expect(joinSegments(['src'], ['lib', 'math.ts'])).toBe('/src/lib/math.ts');
    expect(joinSegments([], ['README.md'])).toBe('/README.md');
    expect(joinSegments([], [])).toBe('/');
  });

  it('ignores empty segments', () => {
    expect(joinSegments(['src', ''], ['', 'main.ts'])).toBe('/src/main.ts');
  });
});

describe('workspace-path: isHiddenPath', () => {
  it('flags any path with a dot-prefixed segment', () => {
    expect(isHiddenPath('/.git/config')).toBe(true);
    expect(isHiddenPath('/src/.env')).toBe(true);
    expect(isHiddenPath('.hidden')).toBe(true);
  });

  it('does not flag ordinary paths', () => {
    expect(isHiddenPath('/src/main.ts')).toBe(false);
    expect(isHiddenPath('/README.md')).toBe(false);
    expect(isHiddenPath('/')).toBe(false);
  });

  it('does not split the whole path when scanning for hidden segments', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split');

    expect(isHiddenPath('/src/components/button.tsx')).toBe(false);
    expect(isHiddenPath('/src/.env')).toBe(true);

    expect(splitSpy).not.toHaveBeenCalled();
    splitSpy.mockRestore();
  });
});

describe('workspace-path: isWithinRoot', () => {
  const root = path.resolve('/tmp/workspace-root');

  it('accepts the root itself and descendants', () => {
    expect(isWithinRoot(root, root)).toBe(true);
    expect(isWithinRoot(root, path.join(root, 'src', 'main.ts'))).toBe(true);
  });

  it('rejects ancestors and siblings outside the root', () => {
    expect(isWithinRoot(root, path.dirname(root))).toBe(false);
    expect(isWithinRoot(root, path.resolve('/tmp/workspace-root-sibling'))).toBe(false);
    expect(isWithinRoot(root, path.resolve('/etc/passwd'))).toBe(false);
  });
});
