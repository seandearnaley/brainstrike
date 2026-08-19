import type { FileExplorerState } from '@brainstrike/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { createNewFolderState } from '../../utils/file-explorer-utils';
import { createFileSelectionActions } from '../file-selection-actions';
import * as selectionReconciliation from '../file-selection-reconciliation';
import { consoleSpy, createMockState, mockSet } from './file-selection-actions-test-support';

const getSelectionAncestorDirectories = (
  selectionReconciliation as typeof selectionReconciliation & {
    getSelectionAncestorDirectories: (
      state: FileExplorerState,
      folderId: string,
      rootPath: string
    ) => string[];
  }
).getSelectionAncestorDirectories;

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
    const removedDirectoryKey = `${folderId}|@|/workspace/src/removed/deep/vanished.ts`;
    const siblingRootKey = 'other-root|@|/other/selected.ts';
    const initialSelection = new Set([
      keepKey,
      vanishedKey,
      nestedKey,
      removedDirectoryKey,
      siblingRootKey,
    ]);
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
          materializedPaths: new Set(['/workspace/src/keep.ts', '/workspace/src/vanished.ts']),
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: ['/workspace/src'],
            excludedPaths: [],
            excludeFilters: [],
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

  it.each([
    ['missing', null],
    [
      'loading',
      {
        directoryCounts: new Map<string, number>(),
        errorMessage: null,
        filePaths: [],
        fingerprint: 'fingerprint-1',
        pathSet: new Set<string>(),
        snapshotId: 'snapshot-1',
        status: 'loading' as const,
      },
    ],
    [
      'errored',
      {
        directoryCounts: new Map<string, number>(),
        errorMessage: 'manifest read failed',
        filePaths: [],
        fingerprint: 'fingerprint-1',
        pathSet: new Set<string>(),
        snapshotId: 'snapshot-1',
        status: 'error' as const,
      },
    ],
    [
      'mismatched',
      {
        directoryCounts: new Map<string, number>(),
        errorMessage: null,
        filePaths: ['/stale/from-another-query.ts'],
        fingerprint: 'other-fingerprint',
        pathSet: new Set(['/stale/from-another-query.ts']),
        snapshotId: 'other-snapshot',
        status: 'ready' as const,
      },
    ],
  ])(
    'reconciles the exact materialized query projection when its manifest is %s',
    (_label, querySelectionManifest) => {
      const folderId = 'root-id';
      const keepPath = '/workspace/src/keep.ts';
      const vanishedPath = '/workspace/src/vanished.ts';
      const materializedPaths = new Set([keepPath, vanishedPath]);
      const state = installStateUpdater(
        createMockState({
          currentFolderId: folderId,
          querySelectionManifest,
          selectedFilePaths: new Set<string>(),
          selectionModel: {
            explicitPaths: new Set<string>(),
            materializedAt: '2026-08-19T00:00:00.000Z',
            materializedPaths,
            mode: 'query',
            queryDescriptor: {
              coveredDirectoryPaths: ['/workspace/src'],
              excludedPaths: [],
              excludeFilters: [],
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
          selectionVersion: 12,
        })
      );

      createFileSelectionActions(state.set, state.getState).reconcileSelectionWithDirectorySnapshot(
        folderId,
        '/workspace/src',
        [{ path: keepPath, type: 'file' }]
      );

      const reconciled = state.getState();
      expect(reconciled.selectionModel.mode).toBe('query');
      expect(reconciled.selectionModel.materializedPaths).toEqual(new Set([keepPath]));
      expect(reconciled.selectionModel.queryDescriptor).toMatchObject({
        excludedPaths: [vanishedPath],
        includedPaths: [],
        totalSelectedCount: 1,
      });
      expect(reconciled.querySelectionManifest).toBe(querySelectionManifest);
      expect(reconciled.selectionVersion).toBe(13);
    }
  );

  it('derives unique selected-file ancestor directories parent-first without walking the tree', () => {
    const folderId = 'root-id';
    const explicitPaths = new Set([
      `${folderId}|@|/workspace/src/nested/deep/file.ts`,
      `${folderId}|@|/workspace/src/other/readme.md`,
      `${folderId}|@|/workspace/root-file.ts`,
      'other-root|@|/other/ignored.ts',
    ]);
    const state = createMockState({
      currentFolderId: folderId,
      selectedFilePaths: explicitPaths,
      selectionModel: {
        explicitPaths,
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit',
        queryDescriptor: null,
      },
    });

    expect(getSelectionAncestorDirectories(state, folderId, '/workspace')).toEqual([
      '/workspace/src',
      '/workspace/src/nested',
      '/workspace/src/other',
      '/workspace/src/nested/deep',
    ]);
  });

  it.each(['persisted-path-without-prefix', '|@|/workspace/src/file.ts', 'root-id|@|'])(
    'rejects malformed persisted selection keys during reconciliation: %s',
    (malformedKey) => {
      const folderId = 'root-id';
      const selectedFilePaths = new Set([malformedKey]);
      const state = installStateUpdater(
        createMockState({
          currentFolderId: folderId,
          selectedFilePaths,
          selectionModel: {
            explicitPaths: selectedFilePaths,
            materializedAt: null,
            materializedPaths: null,
            mode: 'explicit',
            queryDescriptor: null,
          },
        })
      );
      const actions = createFileSelectionActions(state.set, state.getState) as ReturnType<
        typeof createFileSelectionActions
      > &
        SelectionReconciliationAction;

      expect(() =>
        actions.reconcileSelectionWithDirectorySnapshot(folderId, '/workspace/src', [])
      ).toThrow('Invalid composite key format');
    }
  );

  it('preserves Windows path identity while matching drive-root ancestors case-insensitively', () => {
    const folderId = 'root-id';
    const selectedFilePaths = new Set([`${folderId}|@|C:\\Workspace\\src\\nested\\file.ts`]);
    const state = createMockState({
      currentFolderId: folderId,
      selectedFilePaths,
      selectionModel: {
        explicitPaths: selectedFilePaths,
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit',
        queryDescriptor: null,
      },
    });

    expect(getSelectionAncestorDirectories(state, folderId, 'c:\\workspace\\')).toEqual([
      'C:\\Workspace\\src',
      'C:\\Workspace\\src\\nested',
    ]);
  });

  it.each([
    {
      expected: [String.raw`C:\workspace/src`, String.raw`C:\workspace/src\nested`],
      rootPath: String.raw`C:\workspace`,
      selectedPath: String.raw`C:\workspace/src\nested/file.ts`,
    },
    {
      expected: ['C:/workspace/src', 'C:/workspace/src/nested'],
      rootPath: String.raw`C:\workspace`,
      selectedPath: 'C:/workspace/src/nested/file.ts',
    },
    {
      expected: [String.raw`\\server\share/src`, String.raw`\\server\share/src\nested`],
      rootPath: String.raw`\\server\share`,
      selectedPath: String.raw`\\server\share/src\nested/file.ts`,
    },
  ])(
    'preserves each selected path separator presentation while deriving ancestors: $selectedPath',
    ({ expected, rootPath, selectedPath }) => {
      const folderId = 'root-id';
      const selectedFilePaths = new Set([`${folderId}|@|${selectedPath}`]);
      const state = createMockState({
        currentFolderId: folderId,
        selectedFilePaths,
        selectionModel: {
          explicitPaths: selectedFilePaths,
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
        },
      });

      expect(getSelectionAncestorDirectories(state, folderId, rootPath)).toEqual(expected);
    }
  );

  it('does not invent a replacement count from an inexact materialized query cache', () => {
    const folderId = 'root-id';
    const cachedPath = '/workspace/src/cached.ts';
    const materializedPaths = new Set([cachedPath]);
    const selectionModel = {
      explicitPaths: new Set<string>(),
      materializedAt: '2026-08-19T00:00:00.000Z',
      materializedPaths,
      mode: 'query' as const,
      queryDescriptor: {
        coveredDirectoryPaths: ['/workspace/src'],
        excludedPaths: [],
        excludeFilters: [],
        folderId,
        includedPaths: [],
        includeFilters: ['**/*.ts'],
        kind: 'recursive-select-all' as const,
        manifestFingerprint: 'fingerprint-1',
        manifestSnapshotId: 'snapshot-1',
        rootPath: '/workspace',
        totalSelectedCount: 2,
        useRegex: false,
      },
    };
    const state = installStateUpdater(
      createMockState({
        currentFolderId: folderId,
        querySelectionManifest: null,
        selectionModel,
        selectionVersion: 4,
      })
    );

    createFileSelectionActions(state.set, state.getState).reconcileSelectionWithDirectorySnapshot(
      folderId,
      '/workspace/src',
      []
    );

    expect(state.getState().selectionModel).toBe(selectionModel);
    expect(state.getState().selectionVersion).toBe(4);
  });

  it('batches multiple refreshed directories into one selection-state publication', () => {
    const folderId = 'root-id';
    const initialSelection = new Set([
      `${folderId}|@|/workspace/src/gone.ts`,
      `${folderId}|@|/workspace/test/gone.test.ts`,
      `${folderId}|@|/workspace/keep.ts`,
    ]);
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
        selectionVersion: 8,
      })
    );
    const actions = createFileSelectionActions(state.set, state.getState);

    actions.reconcileSelectionWithDirectorySnapshots(folderId, [
      { directoryPath: '/workspace/src', entries: [] },
      { directoryPath: '/workspace/test', entries: [] },
    ]);

    expect(mockSet).toHaveBeenCalledOnce();
    expect(state.getState().selectedFilePaths).toEqual(
      new Set([`${folderId}|@|/workspace/keep.ts`])
    );
    expect(state.getState().selectionVersion).toBe(9);
  });

  it('reconciles a foreign explicit root without disturbing the focused query selection', () => {
    const foreignRoot = 'foreign-root';
    const foreignKey = `${foreignRoot}|@|/foreign/gone.ts`;
    const foreignState = {
      ...createNewFolderState(),
      selectedFilePaths: new Set([foreignKey]),
      selectionModel: {
        explicitPaths: new Set([foreignKey]),
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit' as const,
        queryDescriptor: null,
      },
    };
    const state = installStateUpdater(
      createMockState({
        activeRootIds: ['focused-root', foreignRoot],
        currentFolderId: 'focused-root',
        folderStates: { [foreignRoot]: foreignState },
        querySelectionManifest: {
          directoryCounts: new Map(),
          errorMessage: null,
          filePaths: [],
          fingerprint: 'focused-query',
          pathSet: new Set(),
          snapshotId: 'snapshot-1',
          status: 'ready',
        },
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: '2026-08-19T00:00:00.000Z',
          materializedPaths: new Set<string>(),
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: ['/focused'],
            excludedPaths: [],
            excludeFilters: [],
            folderId: 'focused-root',
            includedPaths: [],
            includeFilters: ['**/*.ts'],
            kind: 'recursive-select-all',
            manifestFingerprint: 'focused-query',
            manifestSnapshotId: 'snapshot-1',
            rootPath: '/focused',
            totalSelectedCount: 0,
            useRegex: false,
          },
        },
      })
    );

    createFileSelectionActions(state.set, state.getState).reconcileSelectionWithDirectorySnapshot(
      foreignRoot,
      '/foreign',
      []
    );

    expect(state.getState().folderStates[foreignRoot]?.selectedFilePaths).toEqual(new Set());
    expect(state.getState().selectionModel.mode).toBe('query');
    expect(state.getState().selectionModel.queryDescriptor?.folderId).toBe('focused-root');
  });

  it('preserves an explicit selection that survives a Windows drive-root snapshot', () => {
    const folderId = 'root-id';
    const path = 'C:\\keep.ts';
    const key = `${folderId}|@|${path}`;
    const selection = new Set([key]);
    const state = installStateUpdater(
      createMockState({
        currentFolderId: folderId,
        selectedFilePaths: selection,
        selectionModel: {
          explicitPaths: selection,
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
        },
        selectionVersion: 3,
      })
    );

    createFileSelectionActions(state.set, state.getState).reconcileSelectionWithDirectorySnapshot(
      folderId,
      'C:\\',
      [{ path, type: 'file' }]
    );

    expect(state.getState().selectedFilePaths).toEqual(selection);
    expect(state.getState().selectionVersion).toBe(3);
  });

  it('preserves a query selection that survives a Windows drive-root snapshot', () => {
    const folderId = 'root-id';
    const path = 'C:\\keep.ts';
    const state = installStateUpdater(
      createMockState({
        currentFolderId: folderId,
        querySelectionManifest: {
          directoryCounts: new Map(),
          errorMessage: null,
          filePaths: [path],
          fingerprint: 'windows-query',
          pathSet: new Set([path]),
          snapshotId: 'snapshot-1',
          status: 'ready',
        },
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: '2026-08-19T00:00:00.000Z',
          materializedPaths: new Set([path]),
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: ['C:\\'],
            excludedPaths: [],
            excludeFilters: [],
            folderId,
            includedPaths: [],
            includeFilters: ['**/*.ts'],
            kind: 'recursive-select-all',
            manifestFingerprint: 'windows-query',
            manifestSnapshotId: 'snapshot-1',
            rootPath: 'C:\\',
            totalSelectedCount: 1,
            useRegex: false,
          },
        },
        selectionVersion: 5,
      })
    );

    createFileSelectionActions(state.set, state.getState).reconcileSelectionWithDirectorySnapshot(
      folderId,
      'C:\\',
      [{ path, type: 'file' }]
    );

    expect(state.getState().selectionModel.queryDescriptor).toMatchObject({
      excludedPaths: [],
      totalSelectedCount: 1,
    });
    expect(state.getState().selectionVersion).toBe(5);
  });

  it.each([
    ['ancestor first', ['ancestor', 'child']],
    ['child first', ['child', 'ancestor']],
  ] as const)(
    'lets an authoritative ancestor disprove a stale child snapshot when ordered %s',
    (_label, order) => {
      const folderId = 'root-id';
      const path = '/workspace/src/keep.ts';
      const key = `${folderId}|@|${path}`;
      const selection = new Set([key]);
      const state = installStateUpdater(
        createMockState({
          currentFolderId: folderId,
          selectedFilePaths: selection,
          selectionModel: {
            explicitPaths: selection,
            materializedAt: null,
            materializedPaths: null,
            mode: 'explicit',
            queryDescriptor: null,
          },
        })
      );
      const snapshots = {
        ancestor: { directoryPath: '/workspace', entries: [] },
        child: {
          directoryPath: '/workspace/src',
          entries: [{ path, type: 'file' as const }],
        },
      };

      createFileSelectionActions(
        state.set,
        state.getState
      ).reconcileSelectionWithDirectorySnapshots(
        folderId,
        order.map((snapshot) => snapshots[snapshot])
      );

      expect(state.getState().selectedFilePaths).toEqual(new Set());
    }
  );

  it('does not let a partial ancestor snapshot disprove a complete child snapshot', () => {
    const folderId = 'root-id';
    const path = '/workspace/src/keep.ts';
    const key = `${folderId}|@|${path}`;
    const selection = new Set([key]);
    const state = installStateUpdater(
      createMockState({
        currentFolderId: folderId,
        selectedFilePaths: selection,
        selectionModel: {
          explicitPaths: selection,
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
        },
      })
    );

    createFileSelectionActions(state.set, state.getState).reconcileSelectionWithDirectorySnapshots(
      folderId,
      [
        {
          directoryPath: '/workspace',
          entries: [{ path: '/workspace/…more', type: 'truncated' }],
        },
        {
          directoryPath: '/workspace/src',
          entries: [{ path, type: 'file' }],
        },
      ]
    );

    expect(state.getState().selectedFilePaths).toEqual(selection);
  });

  it('enforces the files-only selection invariant when a selected file is retyped as a directory', () => {
    const folderId = 'root-id';
    const path = '/workspace/src/replaced.ts';
    const key = `${folderId}|@|${path}`;
    const selection = new Set([key]);
    const state = installStateUpdater(
      createMockState({
        currentFolderId: folderId,
        selectedFilePaths: selection,
        selectionModel: {
          explicitPaths: selection,
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
        },
      })
    );

    createFileSelectionActions(state.set, state.getState).reconcileSelectionWithDirectorySnapshot(
      folderId,
      '/workspace/src',
      [{ path, type: 'directory' }]
    );

    expect(state.getState().selectedFilePaths).toEqual(new Set());
  });
});
