import type { FileExplorerState } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileSelectionActions } from '../file-selection-actions';
import { consoleSpy, createMockState, mockSet } from './file-selection-actions-test-support';

interface DirectorySnapshotEntry {
  path: string;
  type: 'directory' | 'file';
}

interface SelectionReconciliationAction {
  reconcileSelectionWithDirectorySnapshot: (
    folderId: string,
    directoryPath: string,
    entries: readonly DirectorySnapshotEntry[]
  ) => void;
}

function installStateUpdater(initialState: FileExplorerState): {
  getState: () => FileExplorerState;
  set: typeof mockSet;
} {
  let currentState = initialState;
  mockSet.mockImplementation((updater) => {
    if (typeof updater !== 'function') {
      currentState = { ...currentState, ...updater };
      return;
    }
    currentState = { ...currentState, ...updater(currentState) };
  });
  return { getState: () => currentState, set: mockSet };
}

describe('file-selection refresh reconciliation', () => {
  beforeEach(() => {
    mockSet.mockReset();
    consoleSpy.mockClear();
  });

  it('drops only selections disproven by an authoritative directory snapshot', () => {
    const folderId = 'root-id';
    const keepKey = `${folderId}|@|/workspace/src/keep.ts`;
    const vanishedKey = `${folderId}|@|/workspace/src/vanished.ts`;
    const nestedKey = `${folderId}|@|/workspace/src/nested/keep.ts`;
    const siblingRootKey = `other-root|@|/other/selected.ts`;
    const initialSelection = new Set([keepKey, vanishedKey, nestedKey, siblingRootKey]);
    const state = installStateUpdater(
      createMockState({
        currentFolderId: folderId,
        selectedFilePaths: initialSelection,
        selectionModel: {
          explicitPaths: initialSelection,
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
        },
        selectionVersion: 4,
      })
    );
    const actions = createFileSelectionActions(state.set, state.getState) as ReturnType<
      typeof createFileSelectionActions
    > &
      SelectionReconciliationAction;

    actions.reconcileSelectionWithDirectorySnapshot(folderId, '/workspace/src', [
      { path: '/workspace/src/keep.ts', type: 'file' },
      { path: '/workspace/src/nested', type: 'directory' },
    ]);

    expect(state.getState().selectedFilePaths).toEqual(
      new Set([keepKey, nestedKey, siblingRootKey])
    );
    expect(state.getState().selectionModel.explicitPaths).toEqual(
      new Set([keepKey, nestedKey, siblingRootKey])
    );
    expect(state.getState().selectionVersion).toBe(5);
  });

  it('preserves query mode while excluding a vanished manifest-backed file', () => {
    const folderId = 'root-id';
    const state = installStateUpdater(
      createMockState({
        currentFolderId: folderId,
        querySelectionManifest: {
          directoryCounts: new Map([['/workspace/src', 2]]),
          errorMessage: null,
          filePaths: ['/workspace/src/keep.ts', '/workspace/src/vanished.ts'],
          fingerprint: 'fingerprint-1',
          pathSet: new Set(['/workspace/src/keep.ts', '/workspace/src/vanished.ts']),
          snapshotId: 'snapshot-1',
          status: 'ready',
        },
        selectedFilePaths: new Set<string>(),
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: '2026-08-19T00:00:00.000Z',
          materializedPaths: new Set([
            '/workspace/src/keep.ts',
            '/workspace/src/vanished.ts',
          ]),
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: ['/workspace/src'],
            excludeFilters: [],
            excludedPaths: [],
            folderId,
            includedPaths: [],
            includeFilters: ['**/*.ts'],
            kind: 'recursive-select-all',
            manifestFingerprint: 'fingerprint-1',
            manifestSnapshotId: 'snapshot-1',
            rootPath: '/workspace',
            totalSelectedCount: 2,
            useRegex: false,
          },
        },
        selectionVersion: 2,
      })
    );
    const actions = createFileSelectionActions(state.set, state.getState) as ReturnType<
      typeof createFileSelectionActions
    > &
      SelectionReconciliationAction;

    actions.reconcileSelectionWithDirectorySnapshot(folderId, '/workspace/src', [
      { path: '/workspace/src/keep.ts', type: 'file' },
    ]);

    const reconciled = state.getState();
    expect(reconciled.selectionModel.mode).toBe('query');
    expect(reconciled.selectionModel.queryDescriptor).toMatchObject({
      excludedPaths: ['/workspace/src/vanished.ts'],
      totalSelectedCount: 1,
    });
    expect(reconciled.querySelectionManifest?.filePaths).toEqual([
      '/workspace/src/keep.ts',
      '/workspace/src/vanished.ts',
    ]);
    expect(reconciled.selectionVersion).toBe(3);
  });
});
