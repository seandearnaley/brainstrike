import type {
  QuerySelectionManifest,
  SelectionModel,
  SelectionQueryDescriptor,
} from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';

import {
  getDirectorySelectedCount,
  getQuerySelectionMatchingCount,
  getSelectionCount,
  isDirectoryCoveredByQuerySelection,
  isQuerySelectionPathSelected,
  isSelectionPathSelected,
  materializeCompositeKeysForSelectionModel,
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

describe('selection-projection', () => {
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

  it('materializes composite keys from rules and query selections', () => {
    const manifest = createManifest();

    const rulesKeys = materializeCompositeKeysForSelectionModel({
      currentFolderId: 'folder-1',
      querySelectionManifest: null,
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        ...createEmptySelectionModel(),
        materializedPaths: new Set(['/src/index.ts']),
        mode: 'rules',
      },
    });
    expect(rulesKeys).toEqual(new Set(['folder-1|@|/src/index.ts']));

    const queryKeys = materializeCompositeKeysForSelectionModel({
      currentFolderId: 'folder-1',
      querySelectionManifest: manifest,
      selectedFilePaths: new Set<string>(),
      selectionModel: createSelectionModel(),
    });
    expect(queryKeys).toEqual(new Set(['folder-1|@|/src/index.ts', 'folder-1|@|/src/utils.ts']));
  });

  it('returns selection counts for explicit, query, and rules modes', () => {
    const explicitModel: SelectionModel = {
      ...createEmptySelectionModel(),
      explicitPaths: new Set(['/src/index.ts']),
      mode: 'explicit',
    };
    expect(getSelectionCount(explicitModel, new Set(['folder-1|@|/src/index.ts']), null)).toBe(1);

    const queryModel = createSelectionModel();
    expect(getSelectionCount(queryModel, new Set<string>(), createManifest())).toBe(2);

    const rulesModel: SelectionModel = {
      ...createEmptySelectionModel(),
      materializedPaths: new Set(['/src/index.ts', '/src/utils.ts']),
      mode: 'rules',
    };
    expect(getSelectionCount(rulesModel, new Set<string>(), null)).toBe(2);
  });

  it('uses rule materialized paths in generic selection lookup', () => {
    const selectionModel: SelectionModel = {
      ...createEmptySelectionModel(),
      materializedPaths: new Set(['/src/index.ts']),
      mode: 'rules',
    };

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
});
