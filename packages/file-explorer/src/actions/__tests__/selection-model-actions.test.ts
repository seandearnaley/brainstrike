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
      folderStates: {},
      selectedFilePaths: new Set<string>(),
      expandedDirectoryPaths: new Set<string>(),
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      includeProjectTree: true,
      tokenBudget: 100_000,
      folderSummaryThreshold: 5,
      maxSelectionCount: 100,
      lastActiveTab: 'files',
      fileContents: {},
      folderAccessOrder: [],
      quickFilter: '',
      devInlineFixtureEnabled: false,
      selectionVersion: 0,
      selectionModel: createEmptySelectionModel(),
      querySelectionManifest: null,
      rootDirectoryHandle: null,
      ...overrides,
    }) as FileExplorerState;

  const createQueryDescriptor = () => ({
    kind: 'recursive-folder' as const,
    folderId: 'folder1',
    rootPath: 'src',
    coveredDirectoryPaths: ['src'],
    includeFilters: ['**/*.ts'],
    excludeFilters: ['**/*.test.ts'],
    includedPaths: [],
    excludedPaths: [],
    manifestFingerprint: 'fp-1',
    manifestSnapshotId: 'snapshot-1',
    useRegex: false,
    totalSelectedCount: 1,
  });

  describe('setSelectionMode', () => {
    it('should update mode to rules', () => {
      const mockGet = vi.fn(() => createMockState());
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setSelectionMode('rules');

      expect(mockSet).toHaveBeenCalledWith(expect.any(Function));
      const setterFn = mockSet.mock.calls[0][0];
      const currentState = createMockState();
      const result = setterFn(currentState);

      expect(result.selectionModel.mode).toBe('rules');
      expect(result.selectionVersion).toBe(currentState.selectionVersion + 1);
    });

    it('should update mode to explicit', () => {
      const mockGet = vi.fn(() =>
        createMockState({
          selectionModel: {
            ...createEmptySelectionModel(),
            mode: 'rules',
          },
        })
      );
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setSelectionMode('explicit');

      const setterFn = mockSet.mock.calls[0][0];
      const currentState = mockGet();
      const result = setterFn(currentState);

      expect(result.selectionModel.mode).toBe('explicit');
      expect(result.selectionVersion).toBe(currentState.selectionVersion + 1);
    });

    it('clears stale selectedFilePaths when entering rules mode', () => {
      const existingState = createMockState({
        selectedFilePaths: new Set(['folder1|@|src/index.ts']),
      });
      const mockGet = vi.fn(() => existingState);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setSelectionMode('rules');

      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(existingState);

      expect(result.selectedFilePaths).toEqual(new Set<string>());
      expect(result.selectionModel.mode).toBe('rules');
      expect(result.selectionVersion).toBe(existingState.selectionVersion + 1);
    });

    it('clears query descriptor and manifest when leaving query mode', () => {
      const stateWithQuery = createMockState({
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: new Set(['src/index.ts']),
          materializedAt: '2024-01-01T00:00:00Z',
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            useRegex: false,
            totalSelectedCount: 2,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts', '/src/utils.ts'],
          pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
          directoryCounts: new Map([['/src', 2]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const mockGet = vi.fn(() => stateWithQuery);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setSelectionMode('explicit');

      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(stateWithQuery);

      expect(result.selectionModel.mode).toBe('explicit');
      expect(result.selectionModel.queryDescriptor).toBeNull();
      expect(result.querySelectionManifest).toBeNull();
      expect(result.selectionVersion).toBe(stateWithQuery.selectionVersion + 1);
    });
  });

  describe('setSelectionRules', () => {
    it('should set rule set JSON', () => {
      const mockGet = vi.fn(() => createMockState());
      const actions = createSelectionModelActions(mockSet, mockGet);
      const ruleSetJson = '{"schemaVersion":"1.0.0","folderId":"test"}';

      actions.setSelectionRules(ruleSetJson);

      expect(mockSet).toHaveBeenCalledWith(expect.any(Function));
      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(createMockState());

      expect(result.selectionModel.ruleSetJson).toBe(ruleSetJson);
      expect(result.selectionVersion).toBe(1);
    });

    it('should clear materialized cache when rules change', () => {
      const stateWithCache = createMockState({
        selectionModel: {
          mode: 'rules',
          explicitPaths: new Set(),
          ruleSetJson: '{"old":"rules"}',
          materializedPaths: new Set(['path1', 'path2']),
          materializedAt: '2024-01-01T00:00:00Z',
          queryDescriptor: null,
        },
      });
      const mockGet = vi.fn(() => stateWithCache);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setSelectionRules('{"new":"rules"}');

      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(stateWithCache);

      expect(result.selectionModel.materializedPaths).toBeNull();
      expect(result.selectionModel.materializedAt).toBeNull();
      expect(result.selectionVersion).toBe(stateWithCache.selectionVersion + 1);
    });
  });

  describe('clearSelectionRules', () => {
    it('should clear rules and switch to explicit mode', () => {
      const stateWithRules = createMockState({
        selectionModel: {
          mode: 'rules',
          explicitPaths: new Set(['path1']),
          ruleSetJson: '{"some":"rules"}',
          materializedPaths: new Set(['mat1', 'mat2']),
          materializedAt: '2024-01-01T00:00:00Z',
          queryDescriptor: null,
        },
      });
      const mockGet = vi.fn(() => stateWithRules);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.clearSelectionRules();

      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(stateWithRules);

      expect(result.selectionModel.mode).toBe('explicit');
      expect(result.selectionModel.ruleSetJson).toBeNull();
      expect(result.selectionModel.materializedPaths).toBeNull();
      expect(result.selectionModel.materializedAt).toBeNull();
      expect(result.selectionVersion).toBe(stateWithRules.selectionVersion + 1);
    });

    it('clears any lingering query manifest while returning to explicit mode', () => {
      const stateWithRules = createMockState({
        querySelectionManifest: {
          filePaths: ['/src/index.ts'],
          pathSet: new Set(['/src/index.ts']),
          directoryCounts: new Map([['/src', 1]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const mockGet = vi.fn(() => stateWithRules);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.clearSelectionRules();

      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(stateWithRules);

      expect(result.querySelectionManifest).toBeNull();
    });
  });

  describe('commitRulesToExplicit', () => {
    it('should do nothing if not in rules mode', () => {
      const mockGet = vi.fn(() => createMockState());
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.commitRulesToExplicit();

      expect(mockSet).not.toHaveBeenCalled();
    });

    it('should do nothing if no materialized paths', () => {
      const stateWithRulesNoMat = createMockState({
        selectionModel: {
          mode: 'rules',
          explicitPaths: new Set(),
          ruleSetJson: '{"some":"rules"}',
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: null,
        },
      });
      const mockGet = vi.fn(() => stateWithRulesNoMat);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.commitRulesToExplicit();

      expect(mockSet).not.toHaveBeenCalled();
    });

    it('should convert materialized paths to explicit with folder ID', () => {
      const stateWithMaterialized = createMockState({
        currentFolderId: 'folder1',
        selectionModel: {
          mode: 'rules',
          explicitPaths: new Set(),
          ruleSetJson: '{"some":"rules"}',
          materializedPaths: new Set(['src/file1.ts', 'src/file2.ts']),
          materializedAt: '2024-01-01T00:00:00Z',
          queryDescriptor: null,
        },
      });
      const mockGet = vi.fn(() => stateWithMaterialized);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.commitRulesToExplicit();

      expect(mockSet).toHaveBeenCalledWith({
        selectionModel: {
          mode: 'explicit',
          explicitPaths: new Set(['folder1|@|src/file1.ts', 'folder1|@|src/file2.ts']),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: null,
        },
        selectedFilePaths: new Set(['folder1|@|src/file1.ts', 'folder1|@|src/file2.ts']),
        querySelectionManifest: null,
        selectionVersion: stateWithMaterialized.selectionVersion + 1,
      });
    });

    it('should use path directly when no folder ID', () => {
      const stateWithNoFolder = createMockState({
        currentFolderId: null,
        selectionModel: {
          mode: 'rules',
          explicitPaths: new Set(),
          ruleSetJson: '{"some":"rules"}',
          materializedPaths: new Set(['file1.ts']),
          materializedAt: '2024-01-01T00:00:00Z',
          queryDescriptor: null,
        },
      });
      const mockGet = vi.fn(() => stateWithNoFolder);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.commitRulesToExplicit();

      expect(mockSet).toHaveBeenCalledWith({
        selectionModel: {
          mode: 'explicit',
          explicitPaths: new Set(['file1.ts']),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: null,
        },
        selectedFilePaths: new Set(['file1.ts']),
        querySelectionManifest: null,
        selectionVersion: stateWithNoFolder.selectionVersion + 1,
      });
    });
  });

  describe('setMaterializedPaths', () => {
    it('should set materialized paths with timestamp', () => {
      const mockGet = vi.fn(() => createMockState());
      const actions = createSelectionModelActions(mockSet, mockGet);
      const paths = new Set(['path1', 'path2', 'path3']);

      const beforeCall = new Date();
      actions.setMaterializedPaths(paths);
      const afterCall = new Date();

      expect(mockSet).toHaveBeenCalledWith(expect.any(Function));
      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(createMockState());

      expect(result.selectionModel.materializedPaths).toEqual(paths);
      expect(result.selectionModel.materializedAt).toBeDefined();

      // Verify timestamp is valid and recent
      const timestamp = new Date(result.selectionModel.materializedAt);
      expect(timestamp.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(timestamp.getTime()).toBeLessThanOrEqual(afterCall.getTime() + 1000);
    });

    it('syncs rule materialized paths into selectedFilePaths when a folder id exists', () => {
      const stateWithRules = createMockState({
        currentFolderId: 'folder1',
        selectionModel: {
          mode: 'rules',
          explicitPaths: new Set(),
          ruleSetJson: '{"folderId":"folder1"}',
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: null,
        },
      });
      const mockGet = vi.fn(() => stateWithRules);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setMaterializedPaths(new Set(['src/index.ts', 'src/utils.ts']));

      expect(mockSet).toHaveBeenCalledWith({
        selectionModel: {
          ...stateWithRules.selectionModel,
          materializedPaths: new Set(['src/index.ts', 'src/utils.ts']),
          materializedAt: expect.any(String),
        },
        selectedFilePaths: new Set(['folder1|@|src/index.ts', 'folder1|@|src/utils.ts']),
        selectionVersion: stateWithRules.selectionVersion + 1,
      });
    });

    it('should not sync query compatibility paths into selectedFilePaths in query mode', () => {
      const stateWithQuery = createMockState({
        currentFolderId: 'folder1',
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set(),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: ['node_modules'],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            useRegex: false,
            totalSelectedCount: 5000,
          },
        },
      });
      const mockGet = vi.fn(() => stateWithQuery);
      const actions = createSelectionModelActions(mockSet, mockGet);
      const paths = new Set(['src/index.ts', 'src/utils.ts']);

      actions.setMaterializedPaths(paths);

      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(stateWithQuery);

      expect(result).toEqual({
        selectionModel: {
          ...stateWithQuery.selectionModel,
          materializedPaths: paths,
          materializedAt: expect.any(String),
        },
        selectionVersion: stateWithQuery.selectionVersion + 1,
      });
    });
  });

  describe('setQuerySelection', () => {
    it('should switch to query mode and store the exact manifest separately from selectedFilePaths', () => {
      const state = createMockState({
        currentFolderId: 'folder1',
        selectedFilePaths: new Set(['folder1|@|old.ts']),
      });
      const mockGet = vi.fn(() => state);
      const actions = createSelectionModelActions(mockSet, mockGet);
      const queryManifest = {
        filePaths: ['src/index.ts', 'src/utils.ts'],
        pathSet: new Set(['src/index.ts', 'src/utils.ts']),
        directoryCounts: new Map([['src', 2]]),
        fingerprint: 'fp-1',
        snapshotId: 'snapshot-1',
        status: 'ready' as const,
        errorMessage: null,
      };

      actions.setQuerySelection(
        {
          kind: 'recursive-folder',
          folderId: 'folder1',
          rootPath: 'src',
          coveredDirectoryPaths: ['src'],
          includeFilters: ['**/*.ts'],
          excludeFilters: ['**/*.test.ts'],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          useRegex: false,
          totalSelectedCount: 2048,
        },
        queryManifest,
        new Set(['src/index.ts', 'src/utils.ts'])
      );

      const setterFn = mockSet.mock.calls[0][0];
      expect(typeof setterFn).toBe('function');

      const result = setterFn(state);

      expect(result).toEqual({
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set(),
          ruleSetJson: null,
          materializedPaths: new Set(['src/index.ts', 'src/utils.ts']),
          materializedAt: expect.any(String),
          queryDescriptor: {
            kind: 'recursive-folder',
            folderId: 'folder1',
            rootPath: 'src',
            coveredDirectoryPaths: ['src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: ['**/*.test.ts'],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            useRegex: false,
            totalSelectedCount: 2048,
          },
        },
        selectedFilePaths: new Set<string>(),
        querySelectionManifest: queryManifest,
        selectionVersion: state.selectionVersion + 1,
      });
    });

    it('increments selectionVersion from the updater state to avoid lost concurrent bumps', () => {
      const staleState = createMockState({ selectionVersion: 2 });
      const liveState = createMockState({ selectionVersion: 7 });
      const mockGet = vi.fn(() => staleState);
      const actions = createSelectionModelActions(mockSet, mockGet);
      const queryManifest = {
        filePaths: ['src/index.ts'],
        pathSet: new Set(['src/index.ts']),
        directoryCounts: new Map([['src', 1]]),
        fingerprint: 'fp-1',
        snapshotId: 'snapshot-1',
        status: 'ready' as const,
        errorMessage: null,
      };

      actions.setQuerySelection(createQueryDescriptor(), queryManifest);

      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(liveState);

      expect(result.selectionVersion).toBe(8);
    });
  });

  describe('setQuerySelectionManifest', () => {
    it('returns the existing state when manifest and descriptor metadata are unchanged', () => {
      const currentState = createMockState({
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            useRegex: false,
            totalSelectedCount: 2,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts'],
          pathSet: new Set(['/src/index.ts']),
          directoryCounts: new Map([['/src', 1]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const mockGet = vi.fn(() => currentState);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setQuerySelectionManifest(currentState.querySelectionManifest);

      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(currentState);

      expect(result).toBe(currentState);
    });

    it('updates query descriptor manifest metadata when a new manifest arrives', () => {
      const currentState = createMockState({
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-old',
            manifestSnapshotId: 'snapshot-old',
            useRegex: false,
            totalSelectedCount: 2,
          },
        },
      });
      const mockGet = vi.fn(() => currentState);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setQuerySelectionManifest({
        filePaths: ['/src/index.ts', '/src/utils.ts'],
        pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
        directoryCounts: new Map([['/src', 2]]),
        fingerprint: 'fp-new',
        snapshotId: 'snapshot-new',
        status: 'ready',
        errorMessage: null,
      });

      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(currentState);

      expect(result.querySelectionManifest?.fingerprint).toBe('fp-new');
      expect(result.selectionModel.queryDescriptor?.manifestFingerprint).toBe('fp-new');
      expect(result.selectionModel.queryDescriptor?.manifestSnapshotId).toBe('snapshot-new');
    });

    it('treats manifests with different file counts as changed', () => {
      const currentState = createMockState({
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            useRegex: false,
            totalSelectedCount: 2,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts'],
          pathSet: new Set(['/src/index.ts']),
          directoryCounts: new Map([['/src', 1]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const mockGet = vi.fn(() => currentState);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setQuerySelectionManifest({
        filePaths: ['/src/index.ts', '/src/utils.ts'],
        pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
        directoryCounts: new Map([['/src', 2]]),
        fingerprint: 'fp-1',
        snapshotId: 'snapshot-1',
        status: 'ready',
        errorMessage: null,
      });

      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(currentState);

      expect(result).not.toBe(currentState);
      expect(result.querySelectionManifest?.filePaths).toEqual(['/src/index.ts', '/src/utils.ts']);
    });

    it('treats manifests with different file ordering as changed', () => {
      const currentState = createMockState({
        selectionModel: {
          mode: 'query',
          explicitPaths: new Set<string>(),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder1',
            rootPath: null,
            coveredDirectoryPaths: ['/src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            useRegex: false,
            totalSelectedCount: 2,
          },
        },
        querySelectionManifest: {
          filePaths: ['/src/index.ts', '/src/utils.ts'],
          pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
          directoryCounts: new Map([['/src', 2]]),
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
          errorMessage: null,
        },
      });
      const mockGet = vi.fn(() => currentState);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setQuerySelectionManifest({
        filePaths: ['/src/utils.ts', '/src/index.ts'],
        pathSet: new Set(['/src/utils.ts', '/src/index.ts']),
        directoryCounts: new Map([['/src', 2]]),
        fingerprint: 'fp-1',
        snapshotId: 'snapshot-1',
        status: 'ready',
        errorMessage: null,
      });

      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(currentState);

      expect(result).not.toBe(currentState);
      expect(result.querySelectionManifest?.filePaths).toEqual(['/src/utils.ts', '/src/index.ts']);
    });
  });
});
