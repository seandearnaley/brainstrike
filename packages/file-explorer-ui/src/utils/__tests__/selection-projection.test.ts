import type {
  QuerySelectionManifest,
  SelectionModel,
  SelectionQueryDescriptor,
} from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';

import {
  getDirectorySelectedCount,
  isDirectoryCoveredByQuerySelection,
  isQuerySelectionPathSelected,
  isSelectionPathSelected,
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

  it('uses the ready manifest when available', () => {
    const descriptor = createDescriptor();
    const manifest = createManifest();

    expect(isQuerySelectionPathSelected(descriptor, manifest, 'folder-1', '/src/index.ts')).toBe(
      true
    );
    expect(isDirectoryCoveredByQuerySelection(descriptor, manifest, 'folder-1', '/src')).toBe(true);
    expect(getDirectorySelectedCount(descriptor, manifest, 'folder-1', '/src')).toBe(2);
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
});
