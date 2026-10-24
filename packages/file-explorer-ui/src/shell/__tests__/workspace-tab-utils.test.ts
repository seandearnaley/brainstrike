import { describe, expect, it } from 'vitest';
import { getFileName } from '../workspace-tab-utils';

describe('workspace tab titles', () => {
  it.each([
    { path: '/repo/src/index.ts', title: 'index.ts' },
    { path: 'C:\\repo\\src\\index.ts', title: 'index.ts' },
    { path: '\\\\server\\share\\notes.md', title: 'notes.md' },
    { path: 'src/index.ts', title: 'index.ts' },
    // A POSIX name may contain a backslash: it stays in the title.
    { path: '/repo/a\\b.ts', title: 'a\\b.ts' },
  ])('titles $path as $title', ({ path, title }) => {
    expect(getFileName(path)).toBe(title);
  });
});
