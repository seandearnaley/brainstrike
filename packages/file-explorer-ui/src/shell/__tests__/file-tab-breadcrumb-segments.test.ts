// @vitest-environment node
/**
 * Breadcrumb segment derivation (BST-1269): labels are path segments relative
 * to the workspace root; each segment's `path` is the TREE NODE path
 * (cumulative, root-absolute) so clicks can feed OptimizedFileTree's
 * revealPath directly.
 */

import { describe, expect, it } from 'vitest';
import { buildFileBreadcrumbSegments } from '../file-tab-breadcrumb-segments';

describe('buildFileBreadcrumbSegments', () => {
  it('builds root-relative labels with cumulative node paths', () => {
    expect(buildFileBreadcrumbSegments('/repo/src/ui/button.tsx', '/repo')).toEqual([
      { label: 'src', path: '/repo/src' },
      { label: 'ui', path: '/repo/src/ui' },
      { label: 'button.tsx', path: '/repo/src/ui/button.tsx' },
    ]);
  });

  it('handles absolute paths without a known root', () => {
    expect(buildFileBreadcrumbSegments('/src/a.ts', null)).toEqual([
      { label: 'src', path: '/src' },
      { label: 'a.ts', path: '/src/a.ts' },
    ]);
  });

  it('handles relative paths (web roots)', () => {
    expect(buildFileBreadcrumbSegments('docs/readme.md', null)).toEqual([
      { label: 'docs', path: 'docs' },
      { label: 'readme.md', path: 'docs/readme.md' },
    ]);
  });

  it('falls back to full-path segments when the path is outside the root', () => {
    expect(buildFileBreadcrumbSegments('/other/x.ts', '/repo')).toEqual([
      { label: 'other', path: '/other' },
      { label: 'x.ts', path: '/other/x.ts' },
    ]);
  });
});
