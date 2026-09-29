import type {
  QuerySelectionManifest,
  SelectionModel,
  SelectionQueryDescriptor,
} from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __getSelectionProjectionCacheStatsForTests,
  acquireSelectionProjectionStructuralCache,
  getDirectorySelectedCount,
  getQuerySelectionMatchingCount,
  getSelectionCount,
  isDirectoryCoveredByQuerySelection,
  isQuerySelectionPathSelected,
  isSelectionPathSelected,
  materializeCompositeKeysForSelectionModel,
  __resetSelectionProjectionCachesForTests as resetSelectionProjectionCaches,
} from '../selection-projection';

function createDescriptor(
  overrides: Partial<SelectionQueryDescriptor> = {}
): SelectionQueryDescriptor {
  return {
    coveredDirectoryPaths: ['/src'],
    excludedPaths: [],
    excludeFilters: [],
    folderId: 'folder-1',
    includedPaths: [],
    includeFilters: ['**/*.ts'],
    kind: 'recursive-select-all',
    manifestFingerprint: 'fp-1',
    manifestSnapshotId: 'snapshot-1',
    rootPath: null,
    totalSelectedCount: 2,
    useRegex: false,
    ...overrides,
  };
}

function createManifest(overrides: Partial<QuerySelectionManifest> = {}): QuerySelectionManifest {
  return {
    directoryCounts: new Map([['/src', 2]]),
    errorMessage: null,
    filePaths: ['/src/index.ts', '/src/utils.ts'],
    fingerprint: 'fp-1',
    pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
    snapshotId: 'snapshot-1',
    status: 'ready',
    ...overrides,
  };
}

function createSelectionModel(overrides: Partial<SelectionModel> = {}): SelectionModel {
  return {
    ...createEmptySelectionModel(),
    materializedPaths: new Set<string>(),
    mode: 'query',
    queryDescriptor: createDescriptor(),
    ...overrides,
  };
}

let releaseStructuralCacheOwner: (() => void) | null = null;

function resetSelectionProjectionCachesWithOwner(
  limits?: Parameters<typeof resetSelectionProjectionCaches>[0]
): void {
  releaseStructuralCacheOwner?.();
  resetSelectionProjectionCaches(limits);
  releaseStructuralCacheOwner = acquireSelectionProjectionStructuralCache();
}

describe('selection-projection', () => {
  beforeEach(() => {
    resetSelectionProjectionCachesWithOwner();
  });

  afterEach(() => {
    releaseStructuralCacheOwner?.();
    releaseStructuralCacheOwner = null;
    resetSelectionProjectionCaches();
  });

  it('does not strongly retain projections without a live resolver owner', () => {
    releaseStructuralCacheOwner?.();
    releaseStructuralCacheOwner = null;
    resetSelectionProjectionCaches();
    const descriptor = createDescriptor();
    const materializedPaths = new Set(['/src/index.ts']);

    getDirectorySelectedCount(descriptor, null, 'folder-1', '/src', materializedPaths);
    getDirectorySelectedCount(descriptor, null, 'folder-1', '/src', new Set(materializedPaths));

    const cacheStats = __getSelectionProjectionCacheStatsForTests();
    expect(cacheStats).toMatchObject({
      materializedStructuralEntries: 0,
      materializedStructuralHits: 0,
    });
    expect(cacheStats.materializedDirectoryCountBuilds).toBe(2);
  });

  it('reuses materialized directory counts across structurally equal hydrated sets', () => {
    resetSelectionProjectionCachesWithOwner();
    const descriptor = createDescriptor();
    const firstMaterializedPaths = new Set([
      '/src/index.ts',
      '/src/nested/a.ts',
      '/src/nested/deeper/b.ts',
    ]);
    const rehydratedMaterializedPaths = new Set([...firstMaterializedPaths].reverse());

    expect(
      getDirectorySelectedCount(descriptor, null, 'folder-1', '/src', firstMaterializedPaths)
    ).toBe(3);
    expect(
      getDirectorySelectedCount(descriptor, null, 'folder-1', '/src', rehydratedMaterializedPaths)
    ).toBe(3);
    expect(__getSelectionProjectionCacheStatsForTests()).toMatchObject({
      materializedDirectoryCountBuilds: 1,
      materializedStructuralHits: 1,
    });
  });

  it('keeps ordinary equal-length path sets in separate structural buckets', () => {
    const descriptor = createDescriptor();
    const firstMaterializedPaths = new Set(['/a/file.ts']);
    const secondMaterializedPaths = new Set(['/b/file.ts']);

    getDirectorySelectedCount(descriptor, null, 'folder-1', '/a', firstMaterializedPaths);
    getDirectorySelectedCount(descriptor, null, 'folder-1', '/b', secondMaterializedPaths);
    getDirectorySelectedCount(descriptor, null, 'folder-1', '/a', new Set(firstMaterializedPaths));

    expect(__getSelectionProjectionCacheStatsForTests()).toMatchObject({
      materializedDirectoryCountBuilds: 2,
      materializedStructuralHits: 1,
    });
  });

  it('clears strongly retained projections after their resolver lifetime', () => {
    const descriptor = createDescriptor();
    getDirectorySelectedCount(descriptor, null, 'folder-1', '/src', new Set(['/src/index.ts']));

    expect(__getSelectionProjectionCacheStatsForTests().materializedStructuralEntries).toBe(1);

    resetSelectionProjectionCachesWithOwner();

    expect(__getSelectionProjectionCacheStatsForTests()).toMatchObject({
      materializedStructuralEntries: 0,
      materializedStructuralWeight: 0,
    });
  });

  it('separates paths that differ only in their middle segment', () => {
    resetSelectionProjectionCachesWithOwner();
    const descriptor = createDescriptor();
    const firstMaterializedPaths = new Set(['/common/a/file.ts']);
    const collidingMaterializedPaths = new Set(['/common/b/file.ts']);

    expect(
      getDirectorySelectedCount(descriptor, null, 'folder-1', '/common/a', firstMaterializedPaths)
    ).toBe(1);
    expect(
      getDirectorySelectedCount(
        descriptor,
        null,
        'folder-1',
        '/common/a',
        collidingMaterializedPaths
      )
    ).toBe(0);
    expect(
      getDirectorySelectedCount(
        descriptor,
        null,
        'folder-1',
        '/common/b',
        collidingMaterializedPaths
      )
    ).toBe(1);
    expect(__getSelectionProjectionCacheStatsForTests()).toMatchObject({
      materializedDirectoryCountBuilds: 2,
      materializedStructuralHits: 0,
    });

    expect(
      getDirectorySelectedCount(
        descriptor,
        null,
        'folder-1',
        '/common/a',
        new Set(firstMaterializedPaths)
      )
    ).toBe(1);
    expect(__getSelectionProjectionCacheStatsForTests()).toMatchObject({
      materializedDirectoryCountBuilds: 2,
      materializedStructuralHits: 1,
    });
  });

  it('evicts the oldest structural entry at the count limit', () => {
    const descriptor = createDescriptor();
    const initialStats = __getSelectionProjectionCacheStatsForTests();
    const materializedPathSets = Array.from(
      { length: initialStats.maxMaterializedStructuralEntries + 1 },
      (_, index) => new Set([`/${'directory'.repeat(index + 1)}/file.ts`])
    );

    for (const materializedPaths of materializedPathSets) {
      getDirectorySelectedCount(descriptor, null, 'folder-1', '/', materializedPaths);
    }

    const afterEntryChurn = __getSelectionProjectionCacheStatsForTests();
    expect(afterEntryChurn.materializedStructuralEntries).toBe(
      initialStats.maxMaterializedStructuralEntries
    );
    expect(afterEntryChurn.materializedStructuralWeight).toBeLessThanOrEqual(
      initialStats.maxMaterializedStructuralWeight
    );

    getDirectorySelectedCount(descriptor, null, 'folder-1', '/', new Set(materializedPathSets[0]));
    expect(__getSelectionProjectionCacheStatsForTests().materializedDirectoryCountBuilds).toBe(
      materializedPathSets.length + 1
    );
  });

  it('promotes a structural hit before evicting the least recently used entry', () => {
    const descriptor = createDescriptor();
    const initialStats = __getSelectionProjectionCacheStatsForTests();
    const materializedPathSets = Array.from(
      { length: initialStats.maxMaterializedStructuralEntries + 1 },
      (_, index) => new Set([`/${'directory'.repeat(index + 1)}/file.ts`])
    );

    for (const materializedPaths of materializedPathSets.slice(
      0,
      initialStats.maxMaterializedStructuralEntries
    )) {
      getDirectorySelectedCount(descriptor, null, 'folder-1', '/', materializedPaths);
    }
    getDirectorySelectedCount(descriptor, null, 'folder-1', '/', new Set(materializedPathSets[0]));
    getDirectorySelectedCount(
      descriptor,
      null,
      'folder-1',
      '/',
      materializedPathSets[initialStats.maxMaterializedStructuralEntries]
    );

    const afterPromotionAndChurn = __getSelectionProjectionCacheStatsForTests();
    getDirectorySelectedCount(descriptor, null, 'folder-1', '/', new Set(materializedPathSets[1]));
    const afterEvictedRead = __getSelectionProjectionCacheStatsForTests();
    getDirectorySelectedCount(descriptor, null, 'folder-1', '/', new Set(materializedPathSets[0]));

    expect(afterEvictedRead.materializedDirectoryCountBuilds).toBe(
      afterPromotionAndChurn.materializedDirectoryCountBuilds + 1
    );
    expect(__getSelectionProjectionCacheStatsForTests().materializedDirectoryCountBuilds).toBe(
      afterEvictedRead.materializedDirectoryCountBuilds
    );
  });

  it('evicts cumulative weight before reaching the entry-count limit', () => {
    resetSelectionProjectionCachesWithOwner({
      maxMaterializedStructuralEntries: 4,
      maxMaterializedStructuralWeight: 300,
    });
    const descriptor = createDescriptor();
    const initialStats = __getSelectionProjectionCacheStatsForTests();
    const weightedPathSets = Array.from(
      { length: 3 },
      (_, selectionIndex) => new Set([`/root-${selectionIndex}/nested/file.ts`])
    );

    for (const materializedPaths of weightedPathSets) {
      getDirectorySelectedCount(descriptor, null, 'folder-1', '/', materializedPaths);
    }

    const afterWeightChurn = __getSelectionProjectionCacheStatsForTests();
    expect(afterWeightChurn.materializedStructuralEntries).toBeLessThan(weightedPathSets.length);
    expect(afterWeightChurn.materializedStructuralEntries).toBeLessThan(
      initialStats.maxMaterializedStructuralEntries
    );
    expect(afterWeightChurn.materializedStructuralWeight).toBeLessThanOrEqual(
      initialStats.maxMaterializedStructuralWeight
    );
    getDirectorySelectedCount(descriptor, null, 'folder-1', '/', new Set(weightedPathSets[0]));
    expect(__getSelectionProjectionCacheStatsForTests().materializedDirectoryCountBuilds).toBe(
      afterWeightChurn.materializedDirectoryCountBuilds + 1
    );
  });

  it('skips individually oversized structural entries', () => {
    resetSelectionProjectionCachesWithOwner({
      maxMaterializedStructuralEntries: 4,
      maxMaterializedStructuralWeight: 40,
    });
    const descriptor = createDescriptor();
    const oversizedPaths = new Set(['/oversized-a.ts', '/oversized-b.ts']);

    getDirectorySelectedCount(descriptor, null, 'folder-1', '/', oversizedPaths);
    getDirectorySelectedCount(descriptor, null, 'folder-1', '/', new Set(oversizedPaths));

    expect(__getSelectionProjectionCacheStatsForTests()).toMatchObject({
      materializedDirectoryCountBuilds: 2,
      materializedStructuralEntries: 0,
      materializedStructuralPrecheckRejections: 2,
      materializedStructuralWeight: 0,
    });
  });

  it('restores production structural-cache limits between tests', () => {
    const stats = __getSelectionProjectionCacheStatsForTests();

    expect(stats.maxMaterializedStructuralEntries).toBe(4);
    expect(stats.maxMaterializedStructuralWeight).toBe(8_000_000);
  });

  it('does not report a query-selected path before the manifest is ready unless it is materialized', () => {
    const descriptor = createDescriptor();

    expect(isQuerySelectionPathSelected(descriptor, null, 'folder-1', '/src/index.ts', null)).toBe(
      false
    );

    expect(
      isQuerySelectionPathSelected(
        descriptor,
        null,
        'folder-1',
        '/src/index.ts',
        new Set(['/src/index.ts'])
      )
    ).toBe(true);
  });

  it('uses materialized paths for directory coverage and counts while the manifest is loading', () => {
    const descriptor = createDescriptor();
    const materializedPaths = new Set(['/src/index.ts', '/src/nested/a.ts']);

    expect(
      isDirectoryCoveredByQuerySelection(descriptor, null, 'folder-1', '/src', materializedPaths)
    ).toBe(true);
    expect(getDirectorySelectedCount(descriptor, null, 'folder-1', '/src', materializedPaths)).toBe(
      2
    );
  });

  it('falls back to covered directory paths when materialized paths do not cover an ancestor during loading', () => {
    const descriptor = createDescriptor({
      coveredDirectoryPaths: ['/packages', '/packages/agent', '/packages/app-shell'],
    });

    expect(
      isDirectoryCoveredByQuerySelection(
        descriptor,
        null,
        'folder-1',
        '/packages',
        new Set(['packages/agent/index.ts', 'packages/app-shell/main.ts'])
      )
    ).toBe(true);
  });

  it('keeps absolute desktop-style ancestor directories covered while loading', () => {
    const descriptor = createDescriptor({
      coveredDirectoryPaths: [
        '/mock',
        '/mock/desktop-selection-root-packages',
        '/mock/desktop-selection-root-packages/packages',
        '/mock/desktop-selection-root-packages/packages/agent',
        '/mock/desktop-selection-root-packages/packages/app-shell',
      ],
      folderId: '/mock/desktop-selection-root-packages',
    });

    const materializedPaths = new Set([
      '/mock/desktop-selection-root-packages/packages/agent/index.ts',
      '/mock/desktop-selection-root-packages/packages/app-shell/main.ts',
    ]);

    expect(
      isDirectoryCoveredByQuerySelection(
        descriptor,
        null,
        '/mock/desktop-selection-root-packages',
        '/mock/desktop-selection-root-packages/packages',
        materializedPaths
      )
    ).toBe(true);
    expect(
      getDirectorySelectedCount(
        descriptor,
        null,
        '/mock/desktop-selection-root-packages',
        '/mock/desktop-selection-root-packages/packages',
        materializedPaths
      )
    ).toBe(2);
  });

  it('reuses ancestor counts for repeated directory queries while the manifest is loading', () => {
    const descriptor = createDescriptor();
    const materializedPaths = new Set([
      '/src/index.ts',
      '/src/nested/a.ts',
      '/src/nested/deeper/b.ts',
    ]);

    expect(getDirectorySelectedCount(descriptor, null, 'folder-1', '/src', materializedPaths)).toBe(
      3
    );
    expect(
      getDirectorySelectedCount(descriptor, null, 'folder-1', '/src/nested', materializedPaths)
    ).toBe(2);
    expect(
      getDirectorySelectedCount(
        descriptor,
        null,
        'folder-1',
        '/src/nested/deeper',
        materializedPaths
      )
    ).toBe(1);
    expect(
      isDirectoryCoveredByQuerySelection(
        descriptor,
        null,
        'folder-1',
        '/src/nested/deeper',
        materializedPaths
      )
    ).toBe(true);
  });

  it('counts the root directory for absolute materialized paths while loading', () => {
    const descriptor = createDescriptor({
      coveredDirectoryPaths: ['/'],
      folderId: '/workspace',
    });
    const materializedPaths = new Set(['/README.md', '/src/index.ts']);

    expect(getDirectorySelectedCount(descriptor, null, '/workspace', '/', materializedPaths)).toBe(
      2
    );
    expect(
      isDirectoryCoveredByQuerySelection(descriptor, null, '/workspace', '/', materializedPaths)
    ).toBe(true);
  });

  it('uses the ready manifest when available', () => {
    const descriptor = createDescriptor();
    const manifest = createManifest();

    expect(isQuerySelectionPathSelected(descriptor, manifest, 'folder-1', '/src/index.ts')).toBe(
      true
    );
    expect(isDirectoryCoveredByQuerySelection(descriptor, manifest, 'folder-1', '/src')).toBe(true);
    expect(getDirectorySelectedCount(descriptor, manifest, 'folder-1', '/src')).toBe(2);
  });

  it('counts manually included query paths toward directory totals after the manifest is ready', () => {
    const descriptor = createDescriptor({
      coveredDirectoryPaths: ['/src', '/types'],
      includedPaths: ['/types/performance.ts'],
      totalSelectedCount: 3,
    });
    const manifest = createManifest();

    expect(getDirectorySelectedCount(descriptor, manifest, 'folder-1', '/types')).toBe(1);
    expect(getQuerySelectionMatchingCount(descriptor, manifest, 'folder-1', '/types')).toBe(1);
  });

  it('does not count manually included paths that only share a string prefix with a directory', () => {
    const descriptor = createDescriptor({
      coveredDirectoryPaths: ['/src'],
      includedPaths: ['/src-generated/performance.ts'],
      totalSelectedCount: 1,
    });
    const manifest = createManifest({
      directoryCounts: new Map<string, number>(),
      filePaths: [],
      pathSet: new Set<string>(),
    });

    expect(getQuerySelectionMatchingCount(descriptor, manifest, 'folder-1', '/src')).toBe(0);
  });

  it('matches absolute and relative path variants against include and exclude filters', () => {
    const descriptor = createDescriptor({
      excludeFilters: ['src/**/ignore.ts'],
      includeFilters: ['src/**/*.ts'],
    });

    expect(isQuerySelectionPathSelected(descriptor, null, 'folder-1', '/src/index.ts')).toBe(false);
    expect(
      isQuerySelectionPathSelected(
        descriptor,
        null,
        'folder-1',
        '/src/index.ts',
        new Set(['/src/index.ts'])
      )
    ).toBe(true);
    expect(
      isQuerySelectionPathSelected(
        descriptor,
        null,
        'folder-1',
        '/src/ignore.ts',
        new Set(['/src/ignore.ts'])
      )
    ).toBe(false);
  });

  it('does not treat shared string prefixes as being inside the query root', () => {
    const descriptor = createDescriptor({ rootPath: '/src' });

    expect(
      isQuerySelectionPathSelected(
        descriptor,
        null,
        'folder-1',
        '/src-generated/index.ts',
        new Set(['/src-generated/index.ts'])
      )
    ).toBe(false);
  });

  it('propagates materialized path fallback through isSelectionPathSelected in query mode', () => {
    const selectionModel = createSelectionModel({
      materializedPaths: new Set(['/src/index.ts']),
    });

    expect(
      isSelectionPathSelected({
        currentFolderId: 'folder-1',
        path: '/src/index.ts',
        querySelectionManifest: null,
        selectedFilePaths: new Set<string>(),
        selectionModel,
      })
    ).toBe(true);
  });

  it('returns false for query lookups when folder id or root path do not match', () => {
    const descriptor = createDescriptor({ rootPath: '/src' });
    const manifest = createManifest();

    expect(
      isQuerySelectionPathSelected(descriptor, manifest, 'other-folder', '/src/index.ts')
    ).toBe(false);
    expect(isQuerySelectionPathSelected(descriptor, manifest, 'folder-1', '/other/index.ts')).toBe(
      false
    );
    expect(isDirectoryCoveredByQuerySelection(descriptor, manifest, 'other-folder', '/src')).toBe(
      false
    );
    expect(getDirectorySelectedCount(descriptor, manifest, 'other-folder', '/src')).toBe(0);
  });

  it('materializes composite keys from query selections', () => {
    const manifest = createManifest();

    const queryKeys = materializeCompositeKeysForSelectionModel({
      currentFolderId: 'folder-1',
      querySelectionManifest: manifest,
      selectedFilePaths: new Set<string>(),
      selectionModel: createSelectionModel(),
    });
    expect(queryKeys).toEqual(new Set(['folder-1|@|/src/index.ts', 'folder-1|@|/src/utils.ts']));
  });

  it('returns selection counts for explicit and query modes', () => {
    const explicitModel: SelectionModel = {
      ...createEmptySelectionModel(),
      explicitPaths: new Set(['/src/index.ts']),
      mode: 'explicit',
    };
    expect(getSelectionCount(explicitModel, new Set(['folder-1|@|/src/index.ts']), null)).toBe(1);

    const queryModel = createSelectionModel();
    expect(getSelectionCount(queryModel, new Set<string>(), createManifest())).toBe(2);
  });
});
