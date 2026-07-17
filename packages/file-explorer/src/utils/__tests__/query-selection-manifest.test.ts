import type { QuerySelectionManifest, SelectionQueryDescriptor } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  buildQuerySelectionFingerprint,
  buildQuerySelectionManifest,
  createErroredQuerySelectionManifest,
  createLoadingQuerySelectionManifest,
  resolveQuerySelection,
} from '../query-selection-manifest';

function createDescriptor(
  overrides: Partial<SelectionQueryDescriptor> = {}
): SelectionQueryDescriptor {
  return {
    coveredDirectoryPaths: ['/src'],
    excludedPaths: [],
    excludeFilters: ['**/*.test.ts'],
    folderId: 'folder-1',
    includedPaths: [],
    includeFilters: ['**/*.ts'],
    kind: 'recursive-select-all',
    manifestFingerprint: 'fingerprint-1',
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
    fingerprint: 'fingerprint-1',
    pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
    snapshotId: 'snapshot-1',
    status: 'ready',
    ...overrides,
  };
}

describe('query-selection-manifest', () => {
  it('builds a stable fingerprint from query arguments', () => {
    expect(
      buildQuerySelectionFingerprint({
        excludeFilters: ['**/*.test.ts'],
        folderId: 'folder-1',
        includeFilters: ['**/*.ts'],
        kind: 'recursive-folder',
        rootPath: '/src',
        useRegex: false,
      })
    ).toBe(
      JSON.stringify({
        excludeFilters: ['**/*.test.ts'],
        folderId: 'folder-1',
        includeFilters: ['**/*.ts'],
        kind: 'recursive-folder',
        quickFilter: '',
        rootPath: '/src',
        useRegex: false,
      })
    );
  });

  it('normalizes filter ordering when building fingerprints', () => {
    const first = buildQuerySelectionFingerprint({
      excludeFilters: ['**/*.spec.ts', '**/*.test.ts'],
      folderId: 'folder-1',
      includeFilters: ['**/*.tsx', '**/*.ts'],
      kind: 'recursive-folder',
      rootPath: '/src',
      useRegex: false,
    });
    const second = buildQuerySelectionFingerprint({
      excludeFilters: ['**/*.test.ts', '**/*.spec.ts'],
      folderId: 'folder-1',
      includeFilters: ['**/*.ts', '**/*.tsx'],
      kind: 'recursive-folder',
      rootPath: '/src',
      useRegex: false,
    });

    expect(first).toBe(second);
  });

  it('folds the quick filter into the fingerprint so manifests are not cross-reused', () => {
    const base = {
      excludeFilters: [],
      folderId: 'folder-1',
      includeFilters: [],
      kind: 'recursive-folder' as const,
      rootPath: '/src',
      useRegex: false,
    };
    const withFoo = buildQuerySelectionFingerprint({ ...base, quickFilter: 'foo' });
    const withBar = buildQuerySelectionFingerprint({ ...base, quickFilter: 'bar' });
    const withFooAgain = buildQuerySelectionFingerprint({ ...base, quickFilter: 'foo' });
    const withNone = buildQuerySelectionFingerprint(base);

    expect(withFoo).not.toBe(withBar);
    expect(withFoo).toBe(withFooAgain);
    // Absent quick filter is stable and distinct from an active one.
    expect(withNone).not.toBe(withFoo);
    expect(withNone).toBe(buildQuerySelectionFingerprint({ ...base, quickFilter: '' }));
  });

  it('builds a normalized manifest with sorted unique paths and directory counts', () => {
    const manifest = buildQuerySelectionManifest({
      filePaths: ['/src/utils.ts', '/src/index.ts', '/src/index.ts', '/README.md'],
      fingerprint: 'fingerprint-1',
      snapshotId: 'snapshot-1',
    });

    expect(manifest.filePaths).toEqual(['/README.md', '/src/index.ts', '/src/utils.ts']);
    expect(manifest.pathSet).toEqual(new Set(['/README.md', '/src/index.ts', '/src/utils.ts']));
    expect(manifest.directoryCounts).toEqual(
      new Map([
        ['/', 3],
        ['/src', 2],
      ])
    );
    expect(manifest.status).toBe('ready');
    expect(manifest.errorMessage).toBeNull();
  });

  it('counts the root directory for absolute manifest paths', () => {
    const manifest = buildQuerySelectionManifest({
      filePaths: ['/README.md', '/src/index.ts'],
      fingerprint: 'fingerprint-1',
      snapshotId: 'snapshot-1',
    });

    expect(manifest.directoryCounts.get('/')).toBe(2);
    expect(manifest.directoryCounts.get('/src')).toBe(1);
  });

  it('creates loading and errored manifests with shared empty collections', () => {
    const loading = createLoadingQuerySelectionManifest({
      fingerprint: 'fp-loading',
      snapshotId: 'snapshot-loading',
    });
    const errored = createErroredQuerySelectionManifest({
      errorMessage: 'snapshot missing',
      fingerprint: 'fp-error',
      snapshotId: 'snapshot-error',
    });

    expect(loading.status).toBe('loading');
    expect(loading.filePaths).toEqual([]);
    expect(loading.pathSet.size).toBe(0);
    expect(loading.directoryCounts.size).toBe(0);

    expect(errored.status).toBe('error');
    expect(errored.errorMessage).toBe('snapshot missing');
    expect(errored.filePaths).toEqual([]);
    expect(errored.pathSet.size).toBe(0);
    expect(errored.directoryCounts.size).toBe(0);

    loading.pathSet.add('/mutated');
    loading.directoryCounts.set('/mutated', 1);

    const nextLoading = createLoadingQuerySelectionManifest({
      fingerprint: 'fp-loading-2',
      snapshotId: 'snapshot-loading-2',
    });
    expect(nextLoading.pathSet.size).toBe(0);
    expect(nextLoading.directoryCounts.size).toBe(0);
  });

  it('returns an empty resolved selection when descriptor is null', () => {
    const resolved = resolveQuerySelection(null, null);

    expect(resolved.selectedCount).toBe(0);
    expect(resolved.filePaths).toEqual([]);
    expect(resolved.pathSet.size).toBe(0);
    expect(resolved.directoryCounts.size).toBe(0);
  });

  it('falls back to included paths when the manifest is missing or stale', () => {
    const descriptor = createDescriptor({
      includedPaths: ['/manual/a.ts', '/manual/a.ts', '/manual/b.ts'],
      manifestFingerprint: 'expected-fingerprint',
      totalSelectedCount: 99,
    });

    const missingResolved = resolveQuerySelection(descriptor, null);
    const staleResolved = resolveQuerySelection(
      descriptor,
      createManifest({ fingerprint: 'different-fingerprint' })
    );

    expect(missingResolved.filePaths).toEqual(['/manual/a.ts', '/manual/b.ts']);
    expect(missingResolved.pathSet).toEqual(new Set(['/manual/a.ts', '/manual/b.ts']));
    expect(missingResolved.directoryCounts).toEqual(
      new Map([
        ['/', 2],
        ['/manual', 2],
      ])
    );
    expect(missingResolved.selectedCount).toBe(99);

    expect(staleResolved.filePaths).toEqual(['/manual/a.ts', '/manual/b.ts']);
    expect(staleResolved.selectedCount).toBe(99);
  });

  it('resolves manifest-backed selections with include and exclude overrides', () => {
    const descriptor = createDescriptor({
      excludedPaths: ['/src/index.ts'],
      includedPaths: ['/manual/extra.ts'],
      totalSelectedCount: 2,
    });

    const resolved = resolveQuerySelection(descriptor, createManifest());

    expect(resolved.filePaths).toEqual(['/manual/extra.ts', '/src/utils.ts']);
    expect(resolved.pathSet).toEqual(new Set(['/manual/extra.ts', '/src/utils.ts']));
    expect(resolved.directoryCounts).toEqual(
      new Map([
        ['/', 1],
        ['/manual', 1],
        ['/src', 1],
      ])
    );
    expect(resolved.selectedCount).toBe(2);
  });

  it('caches resolved manifest results by manifest and descriptor identity', () => {
    const descriptor = createDescriptor();
    const manifest = createManifest();

    const firstResolved = resolveQuerySelection(descriptor, manifest);
    const secondResolved = resolveQuerySelection(descriptor, manifest);

    expect(secondResolved).toBe(firstResolved);
  });
});
