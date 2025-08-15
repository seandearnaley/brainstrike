import { afterEach, expect, test, vi } from 'vitest';
import type { TreeNode } from '../../lazy-tree-protocol';
import { useExplorerStore } from '../explorer.slice';

// Mock the feature flags to disable worker in tests and make gate available
vi.mock('../../feature-flags', async (importOriginal: () => Promise<unknown>) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isFileExplorerV2Enabled: vi.fn(() => true),
    isFileExplorerV2WorkerEnabled: vi.fn(() => false),
    shouldUseFileExplorerWorker: vi.fn(() => false),
  };
});

afterEach(() => useExplorerStore.getState().teardown());

const tree: TreeNode[] = [
  {
    name: 'src',
    path: '/src',
    type: 'directory',
    children: [
      { name: 'index.ts', path: '/src/index.ts', type: 'file' },
      {
        name: 'lib',
        path: '/src/lib',
        type: 'directory',
        children: [{ name: 'a.ts', path: '/src/lib/a.ts', type: 'file' }],
      },
    ],
  },
];

test('expand/collapse updates visible deterministically (fallback path)', () => {
  // Force fallback by pretending worker flag is off or Worker is undefined in test env
  const s = useExplorerStore.getState();
  s.init({ tree, expanded: [], filter: undefined as unknown as never });

  // initially only root directories (no expansion)
  let rows = useExplorerStore.getState().visible.map((r) => r.path);
  expect(rows).toEqual(['/src']);

  useExplorerStore.getState().expandNode('/src');
  rows = useExplorerStore.getState().visible.map((r) => r.path);
  expect(rows).toEqual(['/src', '/src/index.ts', '/src/lib']);

  useExplorerStore.getState().expandNode('/src/lib');
  rows = useExplorerStore.getState().visible.map((r) => r.path);
  expect(rows).toEqual(['/src', '/src/index.ts', '/src/lib', '/src/lib/a.ts']);

  useExplorerStore.getState().collapseNode('/src');
  rows = useExplorerStore.getState().visible.map((r) => r.path);
  expect(rows).toEqual(['/src']);
});

test('filter applies correctly', () => {
  const s = useExplorerStore.getState();
  s.init({ tree, expanded: ['/src', '/src/lib'], filter: undefined as unknown as never });

  // All visible when expanded
  let rows = useExplorerStore.getState().visible.map((r) => r.path);
  expect(rows).toEqual(['/src', '/src/index.ts', '/src/lib', '/src/lib/a.ts']);

  // Apply filter
  s.applyFilter({ include: ['index'] });
  rows = useExplorerStore.getState().visible.map((r) => r.path);
  // Directories always shown, files only if they match
  expect(rows).toEqual(['/src', '/src/index.ts', '/src/lib']);

  // Clear filter
  s.applyFilter(undefined);
  rows = useExplorerStore.getState().visible.map((r) => r.path);
  expect(rows).toEqual(['/src', '/src/index.ts', '/src/lib', '/src/lib/a.ts']);
});

test('toggleNode switches between expanded and collapsed', () => {
  const s = useExplorerStore.getState();
  s.init({ tree, expanded: [], filter: undefined as unknown as never });

  expect(useExplorerStore.getState().expanded.has('/src')).toBe(false);
  s.toggleNode('/src');
  expect(useExplorerStore.getState().expanded.has('/src')).toBe(true);
  s.toggleNode('/src');
  expect(useExplorerStore.getState().expanded.has('/src')).toBe(false);
});

test('replaceTree maintains expansion state', () => {
  const s = useExplorerStore.getState();
  s.init({ tree, expanded: ['/src'], filter: undefined as unknown as never });

  const newTree: TreeNode[] = [
    {
      name: 'src',
      path: '/src',
      type: 'directory',
      children: [
        { name: 'index.ts', path: '/src/index.ts', type: 'file' },
        { name: 'main.ts', path: '/src/main.ts', type: 'file' },
      ],
    },
  ];

  s.replaceTree(newTree);
  const rows = useExplorerStore.getState().visible.map((r) => r.path);
  // Should still be expanded with new content
  expect(rows).toEqual(['/src', '/src/index.ts', '/src/main.ts']);
  expect(useExplorerStore.getState().expanded.has('/src')).toBe(true);
});
