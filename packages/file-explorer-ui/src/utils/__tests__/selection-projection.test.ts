import type {
  QuerySelectionManifest,
  SelectionModel,
  SelectionQueryDescriptor,
} from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';

import {
  getDirectorySelectedCount,
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
    kind: 'recursive-select-all',
    folderId: 'folder-1',
    rootPath: null,
    coveredDirectoryPaths: ['/src'],
    includeFilters: ['**/*.ts'],
    excludeFilters: [],
    includedPaths: [],
    excludedPaths: [],
    manifestFingerprint: 'fp-1',
    manifestSnapshotId: 'snapshot-1',
    totalSelectedCount: 2,
    useRegex: false,
    ...overrides,
  };
}

function createManifest(overrides: Partial<QuerySelectionManifest> = {}): QuerySelectionManifest {
  return {
    filePaths: ['/src/index.ts', '/src/utils.ts'],
    pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
    directoryCounts: new Map([['/src', 2]]),
    fingerprint: 'fp-1',
    snapshotId: 'snapshot-1',
    status: 'ready',
    errorMessage: null,
    ...overrides,
  };
}

function createSelectionModel(overrides: Partial<SelectionModel> = {}): SelectionModel {
  return {
    ...createEmptySelectionModel(),
    mode: 'query',
    queryDescriptor: createDescriptor(),
    materializedPaths: new Set<string>(),
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

  it('uses the ready manifest when available', () => {
    const descriptor = createDescriptor();
    const manifest = createManifest();

    expect(isQuerySelectionPathSelected(descriptor, manifest, 'folder-1', '/src/index.ts')).toBe(
      true
    );
    expect(isDirectoryCoveredByQuerySelection(descriptor, manifest, 'folder-1', '/src')).toBe(true);
    expect(getDirectorySelectedCount(descriptor, manifest, 'folder-1', '/src')).toBe(2);
  });

  it('matches absolute and relative path variants against include and exclude filters', () => {
    const descriptor = createDescriptor({
      includeFilters: ['src/**/*.ts'],
      excludeFilters: ['src/**/ignore.ts'],
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
      selectedFilePaths: new Set<string>(),
      querySelectionManifest: null,
      selectionModel: {
        ...createEmptySelectionModel(),
        mode: 'rules',
        materializedPaths: new Set(['/src/index.ts']),
      },
    });
    expect(rulesKeys).toEqual(new Set(['folder-1|@|/src/index.ts']));

    const queryKeys = materializeCompositeKeysForSelectionModel({
      currentFolderId: 'folder-1',
      selectedFilePaths: new Set<string>(),
      querySelectionManifest: manifest,
      selectionModel: createSelectionModel(),
    });
    expect(queryKeys).toEqual(new Set(['folder-1|@|/src/index.ts', 'folder-1|@|/src/utils.ts']));
  });

  it('returns selection counts for explicit, query, and rules modes', () => {
    const explicitModel: SelectionModel = {
      ...createEmptySelectionModel(),
      mode: 'explicit',
      explicitPaths: new Set(['/src/index.ts']),
    };
    expect(getSelectionCount(explicitModel, new Set(['folder-1|@|/src/index.ts']), null)).toBe(1);

    const queryModel = createSelectionModel();
    expect(getSelectionCount(queryModel, new Set<string>(), createManifest())).toBe(2);

    const rulesModel: SelectionModel = {
      ...createEmptySelectionModel(),
      mode: 'rules',
      materializedPaths: new Set(['/src/index.ts', '/src/utils.ts']),
    };
    expect(getSelectionCount(rulesModel, new Set<string>(), null)).toBe(2);
  });

  it('uses rule materialized paths in generic selection lookup', () => {
    const selectionModel: SelectionModel = {
      ...createEmptySelectionModel(),
      mode: 'rules',
      materializedPaths: new Set(['/src/index.ts']),
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
