import type { FileExplorerState } from '@brainstrike/types';
import { createEmptySelectionModel } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSelectionModelActions } from '../selection-model-actions';

describe('selection-model-actions', () => {
  const mockSet = vi.fn();

  beforeEach(() => {
    mockSet.mockClear();
  });

  // Helper to create a full mock state
  const createMockState = (overrides: Partial<FileExplorerState> = {}): FileExplorerState =>
    ({
      currentFolderId: 'folder1',
      devInlineFixtureEnabled: false,
      excludeFilters: [],
      expandedDirectoryPaths: new Set<string>(),
      fileContents: {},
      folderAccessOrder: [],
      folderStates: {},
      folderSummaryThreshold: 5,
      includeFilters: [],
      includeProjectTree: true,
      lastActiveTab: 'files',
      maxSelectionCount: 100,
      querySelectionManifest: null,
      quickFilter: '',
      rootDirectoryHandle: null,
      selectedFilePaths: new Set<string>(),
      selectionModel: createEmptySelectionModel(),
      selectionVersion: 0,
      tokenBudget: 100_000,
      useRegex: false,
      ...overrides,
    }) as FileExplorerState;

  const createQueryDescriptor = () => ({
    coveredDirectoryPaths: ['src'],
    excludedPaths: [],
    excludeFilters: ['**/*.test.ts'],
    folderId: 'folder1',
    includedPaths: [],
    includeFilters: ['**/*.ts'],
    kind: 'recursive-folder' as const,
    manifestFingerprint: 'fp-1',
    manifestSnapshotId: 'snapshot-1',
    rootPath: 'src',
    totalSelectedCount: 1,
    useRegex: false,
  });

  describe('setSelectionMode', () => {
    it('should update mode to query', () => {
      const actions = createSelectionModelActions(mockSet);

      actions.setSelectionMode('query');

      expect(mockSet).toHaveBeenCalledWith(expect.any(Function));
      const setterFn = mockSet.mock.calls[0]?.[0];
      const currentState = createMockState();
      const result = setterFn(currentState);

      expect(result.selectionModel.mode).toBe('query');
      expect(result.selectionVersion).toBe(currentState.selectionVersion + 1);
    });

    it('should update mode to explicit', () => {
      const actions = createSelectionModelActions(mockSet);

      actions.setSelectionMode('explicit');

      const setterFn = mockSet.mock.calls[0]?.[0];
      const currentState = createMockState({
        selectionModel: {
          ...createEmptySelectionModel(),
          mode: 'query',
        },
      });
      const result = setterFn(currentState);

      expect(result.selectionModel.mode).toBe('explicit');
      expect(result.selectionVersion).toBe(currentState.selectionVersion + 1);
    });

    it('clears stale selectedFilePaths when entering query mode', () => {
      const existingState = createMockState({
        selectedFilePaths: new Set(['folder1|@|src/index.ts']),
      });
      const actions = createSelectionModelActions(mockSet);

      actions.setSelectionMode('query');

      const setterFn = mockSet.mock.calls[0]?.[0];
      const result = setterFn(existingState);

      expect(result.selectedFilePaths).toEqual(new Set<string>());
      expect(result.selectionModel.mode).toBe('query');
      expect(result.selectionVersion).toBe(existingState.selectionVersion + 1);
    });

    it('clears query descriptor and manifest when leaving query mode', () => {
      const stateWithQuery = createMockState({
        querySelectionManifest: {
          directoryCounts: new Map([['/src', 2]]),
          errorMessage: null,
          filePaths: ['/src/index.ts', '/src/utils.ts'],
          fingerprint: 'fp-1',
          pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
          snapshotId: 'snapshot-1',
          status: 'ready',
        },
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: '2024-01-01T00:00:00Z',
          materializedPaths: new Set(['src/index.ts']),
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: ['/src'],
            excludedPaths: [],
            excludeFilters: [],
            folderId: 'folder1',
            includedPaths: [],
            includeFilters: ['**/*.ts'],
            kind: 'recursive-select-all',
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            rootPath: null,
            totalSelectedCount: 2,
            useRegex: false,
          },
        },
      });
      const actions = createSelectionModelActions(mockSet);

      actions.setSelectionMode('explicit');

      const setterFn = mockSet.mock.calls[0]?.[0];
      const result = setterFn(stateWithQuery);

      expect(result.selectionModel.mode).toBe('explicit');
      expect(result.selectionModel.queryDescriptor).toBeNull();
      expect(result.querySelectionManifest).toBeNull();
      expect(result.selectionVersion).toBe(stateWithQuery.selectionVersion + 1);
    });
  });

  describe('resetSelectionToExplicit', () => {
    it('clears the query selection and switches to explicit mode', () => {
      const stateWithQuery = createMockState({
        selectionModel: {
          explicitPaths: new Set(['path1']),
          materializedAt: '2024-01-01T00:00:00Z',
          materializedPaths: new Set(['mat1', 'mat2']),
          mode: 'query',
          queryDescriptor: createQueryDescriptor(),
        },
      });
      const actions = createSelectionModelActions(mockSet);

      actions.resetSelectionToExplicit();

      const setterFn = mockSet.mock.calls[0]?.[0];
      const result = setterFn(stateWithQuery);

      expect(result.selectionModel.mode).toBe('explicit');
      expect(result.selectionModel.queryDescriptor).toBeNull();
      expect(result.selectionModel.materializedPaths).toBeNull();
      expect(result.selectionModel.materializedAt).toBeNull();
      expect(result.selectionVersion).toBe(stateWithQuery.selectionVersion + 1);
    });

    it('clears any lingering query manifest while returning to explicit mode', () => {
      const stateWithManifest = createMockState({
        querySelectionManifest: {
          directoryCounts: new Map([['/src', 1]]),
          errorMessage: null,
          filePaths: ['/src/index.ts'],
          fingerprint: 'fp-1',
          pathSet: new Set(['/src/index.ts']),
          snapshotId: 'snapshot-1',
          status: 'ready',
        },
      });
      const actions = createSelectionModelActions(mockSet);

      actions.resetSelectionToExplicit();

      const setterFn = mockSet.mock.calls[0]?.[0];
      const result = setterFn(stateWithManifest);

      expect(result.querySelectionManifest).toBeNull();
    });
  });

  describe('setQuerySelection', () => {
    it('should switch to query mode and store the exact manifest separately from selectedFilePaths', () => {
      const state = createMockState({
        currentFolderId: 'folder1',
        selectedFilePaths: new Set(['folder1|@|old.ts']),
      });
      const actions = createSelectionModelActions(mockSet);
      const queryManifest = {
        directoryCounts: new Map([['src', 2]]),
        errorMessage: null,
        filePaths: ['src/index.ts', 'src/utils.ts'],
        fingerprint: 'fp-1',
        pathSet: new Set(['src/index.ts', 'src/utils.ts']),
        snapshotId: 'snapshot-1',
        status: 'ready' as const,
      };

      actions.setQuerySelection(
        {
          coveredDirectoryPaths: ['src'],
          excludedPaths: [],
          excludeFilters: ['**/*.test.ts'],
          folderId: 'folder1',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-folder',
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          rootPath: 'src',
          totalSelectedCount: 2048,
          useRegex: false,
        },
        queryManifest,
        new Set(['src/index.ts', 'src/utils.ts'])
      );

      const setterFn = mockSet.mock.calls[0]?.[0];
      expect(typeof setterFn).toBe('function');

      const result = setterFn(state);

      expect(result).toEqual({
        querySelectionManifest: queryManifest,
        selectedFilePaths: new Set<string>(),
        selectionModel: {
          explicitPaths: new Set(),
          materializedAt: expect.any(String),
          materializedPaths: new Set(['src/index.ts', 'src/utils.ts']),
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: ['src'],
            excludedPaths: [],
            excludeFilters: ['**/*.test.ts'],
            folderId: 'folder1',
            includedPaths: [],
            includeFilters: ['**/*.ts'],
            kind: 'recursive-folder',
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            rootPath: 'src',
            totalSelectedCount: 2048,
            useRegex: false,
          },
        },
        selectionVersion: state.selectionVersion + 1,
      });
    });

    it('increments selectionVersion from the updater state to avoid lost concurrent bumps', () => {
      const liveState = createMockState({ selectionVersion: 7 });
      const actions = createSelectionModelActions(mockSet);
      const queryManifest = {
        directoryCounts: new Map([['src', 1]]),
        errorMessage: null,
        filePaths: ['src/index.ts'],
        fingerprint: 'fp-1',
        pathSet: new Set(['src/index.ts']),
        snapshotId: 'snapshot-1',
        status: 'ready' as const,
      };

      actions.setQuerySelection(createQueryDescriptor(), queryManifest);

      const setterFn = mockSet.mock.calls[0]?.[0];
      const result = setterFn(liveState);

      expect(result.selectionVersion).toBe(8);
    });
  });

  describe('setQuerySelectionManifest', () => {
    it('returns an empty patch when manifest and descriptor metadata are unchanged', () => {
      const currentState = createMockState({
        querySelectionManifest: {
          directoryCounts: new Map([['/src', 1]]),
          errorMessage: null,
          filePaths: ['/src/index.ts'],
          fingerprint: 'fp-1',
          pathSet: new Set(['/src/index.ts']),
          snapshotId: 'snapshot-1',
          status: 'ready',
        },
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: ['/src'],
            excludedPaths: [],
            excludeFilters: [],
            folderId: 'folder1',
            includedPaths: [],
            includeFilters: ['**/*.ts'],
            kind: 'recursive-select-all',
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            rootPath: null,
            totalSelectedCount: 2,
            useRegex: false,
          },
        },
      });
      const actions = createSelectionModelActions(mockSet);

      actions.setQuerySelectionManifest(currentState.querySelectionManifest);

      const setterFn = mockSet.mock.calls[0]?.[0];
      const result = setterFn(currentState);

      expect(result).toEqual({});
    });

    it('updates query descriptor manifest metadata when a new manifest arrives', () => {
      const currentState = createMockState({
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: ['/src'],
            excludedPaths: [],
            excludeFilters: [],
            folderId: 'folder1',
            includedPaths: [],
            includeFilters: ['**/*.ts'],
            kind: 'recursive-select-all',
            manifestFingerprint: 'fp-old',
            manifestSnapshotId: 'snapshot-old',
            rootPath: null,
            totalSelectedCount: 2,
            useRegex: false,
          },
        },
      });
      const actions = createSelectionModelActions(mockSet);

      actions.setQuerySelectionManifest({
        directoryCounts: new Map([['/src', 2]]),
        errorMessage: null,
        filePaths: ['/src/index.ts', '/src/utils.ts'],
        fingerprint: 'fp-new',
        pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
        snapshotId: 'snapshot-new',
        status: 'ready',
      });

      const setterFn = mockSet.mock.calls[0]?.[0];
      const result = setterFn(currentState);

      expect(result.querySelectionManifest?.fingerprint).toBe('fp-new');
      expect(result.selectionModel.queryDescriptor?.manifestFingerprint).toBe('fp-new');
      expect(result.selectionModel.queryDescriptor?.manifestSnapshotId).toBe('snapshot-new');
    });

    it('treats manifests with different file counts as changed', () => {
      const currentState = createMockState({
        querySelectionManifest: {
          directoryCounts: new Map([['/src', 1]]),
          errorMessage: null,
          filePaths: ['/src/index.ts'],
          fingerprint: 'fp-1',
          pathSet: new Set(['/src/index.ts']),
          snapshotId: 'snapshot-1',
          status: 'ready',
        },
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: ['/src'],
            excludedPaths: [],
            excludeFilters: [],
            folderId: 'folder1',
            includedPaths: [],
            includeFilters: ['**/*.ts'],
            kind: 'recursive-select-all',
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            rootPath: null,
            totalSelectedCount: 2,
            useRegex: false,
          },
        },
      });
      const actions = createSelectionModelActions(mockSet);

      actions.setQuerySelectionManifest({
        directoryCounts: new Map([['/src', 2]]),
        errorMessage: null,
        filePaths: ['/src/index.ts', '/src/utils.ts'],
        fingerprint: 'fp-1',
        pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
        snapshotId: 'snapshot-1',
        status: 'ready',
      });

      const setterFn = mockSet.mock.calls[0]?.[0];
      const result = setterFn(currentState);

      expect(result).not.toBe(currentState);
      expect(result.querySelectionManifest?.filePaths).toEqual(['/src/index.ts', '/src/utils.ts']);
    });

    it('treats manifests with different file ordering as changed', () => {
      const currentState = createMockState({
        querySelectionManifest: {
          directoryCounts: new Map([['/src', 2]]),
          errorMessage: null,
          filePaths: ['/src/index.ts', '/src/utils.ts'],
          fingerprint: 'fp-1',
          pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
          snapshotId: 'snapshot-1',
          status: 'ready',
        },
        selectionModel: {
          explicitPaths: new Set<string>(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: ['/src'],
            excludedPaths: [],
            excludeFilters: [],
            folderId: 'folder1',
            includedPaths: [],
            includeFilters: ['**/*.ts'],
            kind: 'recursive-select-all',
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            rootPath: null,
            totalSelectedCount: 2,
            useRegex: false,
          },
        },
      });
      const actions = createSelectionModelActions(mockSet);

      actions.setQuerySelectionManifest({
        directoryCounts: new Map([['/src', 2]]),
        errorMessage: null,
        filePaths: ['/src/utils.ts', '/src/index.ts'],
        fingerprint: 'fp-1',
        pathSet: new Set(['/src/utils.ts', '/src/index.ts']),
        snapshotId: 'snapshot-1',
        status: 'ready',
      });

      const setterFn = mockSet.mock.calls[0]?.[0];
      const result = setterFn(currentState);

      expect(result).not.toBe(currentState);
      expect(result.querySelectionManifest?.filePaths).toEqual(['/src/utils.ts', '/src/index.ts']);
    });
  });
});
