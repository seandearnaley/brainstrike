import { createEmptyRuleSet, serializeRuleSet } from '@brainstrike/selection-rules';
import { createDirectoryNode, createFileNode } from '@brainstrike/test-utils';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileExplorerStoreContext } from '../../shell/file-explorer-provider';
import { useRuleMaterialization } from '../use-rule-materialization';

function createValidRuleSet(folderId: string, patterns: string[]) {
  const base = createEmptyRuleSet(folderId);
  return {
    ...base,
    rules: [
      {
        type: 'glob-include' as const,
        id: 'r1',
        patterns,
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

vi.mock('../../shell/file-explorer-provider', () => {
  const useFileExplorerStoreContext = vi.fn();
  return {
    useFileExplorerStoreContext,
    useFileExplorerStoreSelector: vi.fn((selector: (state: unknown) => unknown) => {
      const store = useFileExplorerStoreContext();
      return store(selector);
    }),
  };
});

const defaultSelectionModel = {
  mode: 'explicit' as const,
  explicitPaths: new Set<string>(),
  ruleSetJson: null,
  materializedPaths: null,
  materializedAt: null,
};

function createMockStore(overrides: Partial<Record<string, unknown>> = {}) {
  const setMaterializedPaths = vi.fn();
  const state = {
    selectionModel: defaultSelectionModel,
    setMaterializedPaths,
    ...overrides,
  };
  const store = vi.fn((selector: (s: typeof state) => unknown) => selector(state));
  Object.assign(store, { getState: () => state });
  return {
    store: store as unknown as ReturnType<typeof useFileExplorerStoreContext>,
    setMaterializedPaths,
  };
}

const sampleFileTree = [
  createDirectoryNode({
    name: 'src',
    path: '/src',
    children: [
      createFileNode({ name: 'index.ts', path: '/src/index.ts' }),
      createFileNode({ name: 'utils.ts', path: '/src/utils.ts' }),
      createDirectoryNode({
        name: 'components',
        path: '/src/components',
        children: [createFileNode({ name: 'Button.tsx', path: '/src/components/Button.tsx' })],
      }),
    ],
  }),
  createDirectoryNode({
    name: 'src-generated',
    path: '/src-generated',
    children: [createFileNode({ name: 'fake.ts', path: '/src-generated/fake.ts' })],
  }),
  createFileNode({ name: 'README.md', path: '/README.md' }),
];

describe('useRuleMaterialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not evaluate rules in explicit mode', () => {
    const { store, setMaterializedPaths } = createMockStore();
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    renderHook(() => useRuleMaterialization({ fileTree: sampleFileTree }));

    expect(setMaterializedPaths).not.toHaveBeenCalled();
  });

  it('clears materialized paths when in rules mode but no ruleSetJson', () => {
    const { store, setMaterializedPaths } = createMockStore({
      selectionModel: {
        ...defaultSelectionModel,
        mode: 'rules' as const,
        ruleSetJson: null,
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    renderHook(() => useRuleMaterialization({ fileTree: sampleFileTree }));

    expect(setMaterializedPaths).toHaveBeenCalledWith(new Set());
  });

  it('does not evaluate rules when disabled', () => {
    const ruleSetJson = serializeRuleSet(createValidRuleSet('root', ['**/*.ts']));
    const { store, setMaterializedPaths } = createMockStore({
      selectionModel: {
        ...defaultSelectionModel,
        mode: 'rules' as const,
        ruleSetJson,
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    renderHook(() => useRuleMaterialization({ fileTree: sampleFileTree, enabled: false }));

    expect(setMaterializedPaths).not.toHaveBeenCalled();
  });

  it('does not evaluate rules when file tree is empty', () => {
    const ruleSetJson = serializeRuleSet(createValidRuleSet('root', ['**/*.ts']));
    const { store, setMaterializedPaths } = createMockStore({
      selectionModel: {
        ...defaultSelectionModel,
        mode: 'rules' as const,
        ruleSetJson,
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    renderHook(() => useRuleMaterialization({ fileTree: [] }));

    expect(setMaterializedPaths).not.toHaveBeenCalled();
  });

  it('evaluates rules and sets materialized paths', () => {
    const ruleSetJson = serializeRuleSet(createValidRuleSet('root', ['**/*.ts']));
    const { store, setMaterializedPaths } = createMockStore({
      selectionModel: {
        ...defaultSelectionModel,
        mode: 'rules' as const,
        ruleSetJson,
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    renderHook(() => useRuleMaterialization({ fileTree: sampleFileTree }));

    expect(setMaterializedPaths).toHaveBeenCalled();
    const paths = setMaterializedPaths.mock.calls[0]?.[0] as Set<string>;
    expect(paths).toBeInstanceOf(Set);
    expect(paths.has('/src/index.ts')).toBe(true);
    expect(paths.has('/src/utils.ts')).toBe(true);
    // .tsx not matched by *.ts pattern
    expect(paths.has('/src/components/Button.tsx')).toBe(false);
    // .md not matched
    expect(paths.has('/README.md')).toBe(false);
  });

  it('materializes root rules with slash-boundary and maxDepth semantics', () => {
    const ruleSetJson = serializeRuleSet({
      ...createValidRuleSet('root', []),
      rules: [
        {
          type: 'root-include' as const,
          id: 'r1',
          roots: ['/src'],
          maxDepth: 0,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const { store, setMaterializedPaths } = createMockStore({
      selectionModel: {
        ...defaultSelectionModel,
        mode: 'rules' as const,
        ruleSetJson,
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    renderHook(() => useRuleMaterialization({ fileTree: sampleFileTree }));

    const paths = setMaterializedPaths.mock.calls[0]?.[0] as Set<string>;
    expect(paths).toEqual(new Set(['/src/index.ts', '/src/utils.ts']));
  });

  it('clears materialized paths on invalid JSON', () => {
    const { store, setMaterializedPaths } = createMockStore({
      selectionModel: {
        ...defaultSelectionModel,
        mode: 'rules' as const,
        ruleSetJson: 'invalid json {{{',
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    renderHook(() => useRuleMaterialization({ fileTree: sampleFileTree }));

    // On error, materialized paths should be cleared
    expect(setMaterializedPaths).toHaveBeenCalledWith(new Set());
  });

  it('returns matchedCount from selectionModel', () => {
    const materializedPaths = new Set(['/a.ts', '/b.ts', '/c.ts']);
    const { store } = createMockStore({
      selectionModel: {
        ...defaultSelectionModel,
        mode: 'rules' as const,
        materializedPaths,
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    const { result } = renderHook(() => useRuleMaterialization({ fileTree: [] }));

    expect(result.current.matchedCount).toBe(3);
  });
});
