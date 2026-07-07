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
          ruleSetJson: null,
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
          explicitPaths: new Set(),
          materializedAt: '2024-01-01T00:00:00Z',
          materializedPaths: new Set(['path1', 'path2']),
          mode: 'rules',
          queryDescriptor: null,
          ruleSetJson: '{"old":"rules"}',
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
          explicitPaths: new Set(['path1']),
          materializedAt: '2024-01-01T00:00:00Z',
          materializedPaths: new Set(['mat1', 'mat2']),
          mode: 'rules',
          queryDescriptor: null,
          ruleSetJson: '{"some":"rules"}',
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
          directoryCounts: new Map([['/src', 1]]),
          errorMessage: null,
          filePaths: ['/src/index.ts'],
          fingerprint: 'fp-1',
          pathSet: new Set(['/src/index.ts']),
          snapshotId: 'snapshot-1',
          status: 'ready',
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
          explicitPaths: new Set(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'rules',
          queryDescriptor: null,
          ruleSetJson: '{"some":"rules"}',
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
          explicitPaths: new Set(),
          materializedAt: '2024-01-01T00:00:00Z',
          materializedPaths: new Set(['src/file1.ts', 'src/file2.ts']),
          mode: 'rules',
          queryDescriptor: null,
          ruleSetJson: '{"some":"rules"}',
        },
      });
      const mockGet = vi.fn(() => stateWithMaterialized);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.commitRulesToExplicit();

      expect(mockSet).toHaveBeenCalledWith({
        querySelectionManifest: null,
        selectedFilePaths: new Set(['folder1|@|src/file1.ts', 'folder1|@|src/file2.ts']),
        selectionModel: {
          explicitPaths: new Set(['folder1|@|src/file1.ts', 'folder1|@|src/file2.ts']),
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
          ruleSetJson: null,
        },
        selectionVersion: stateWithMaterialized.selectionVersion + 1,
      });
    });

    it('should use path directly when no folder ID', () => {
      const stateWithNoFolder = createMockState({
        currentFolderId: null,
        selectionModel: {
          explicitPaths: new Set(),
          materializedAt: '2024-01-01T00:00:00Z',
          materializedPaths: new Set(['file1.ts']),
          mode: 'rules',
          queryDescriptor: null,
          ruleSetJson: '{"some":"rules"}',
        },
      });
      const mockGet = vi.fn(() => stateWithNoFolder);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.commitRulesToExplicit();

      expect(mockSet).toHaveBeenCalledWith({
        querySelectionManifest: null,
        selectedFilePaths: new Set(['file1.ts']),
        selectionModel: {
          explicitPaths: new Set(['file1.ts']),
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
          ruleSetJson: null,
        },
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
          explicitPaths: new Set(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'rules',
          queryDescriptor: null,
          ruleSetJson: '{"folderId":"folder1"}',
        },
      });
      const mockGet = vi.fn(() => stateWithRules);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setMaterializedPaths(new Set(['src/index.ts', 'src/utils.ts']));

      expect(mockSet).toHaveBeenCalledWith({
        selectedFilePaths: new Set(['folder1|@|src/index.ts', 'folder1|@|src/utils.ts']),
        selectionModel: {
          ...stateWithRules.selectionModel,
          materializedAt: expect.any(String),
          materializedPaths: new Set(['src/index.ts', 'src/utils.ts']),
        },
        selectionVersion: stateWithRules.selectionVersion + 1,
      });
    });

    it('should not sync query compatibility paths into selectedFilePaths in query mode', () => {
      const stateWithQuery = createMockState({
        currentFolderId: 'folder1',
        selectionModel: {
          explicitPaths: new Set(),
          materializedAt: null,
          materializedPaths: null,
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: ['src'],
            excludedPaths: [],
            excludeFilters: ['node_modules'],
            folderId: 'folder1',
            includedPaths: [],
            includeFilters: ['**/*.ts'],
            kind: 'recursive-select-all',
            manifestFingerprint: 'fp-1',
            manifestSnapshotId: 'snapshot-1',
            rootPath: null,
            totalSelectedCount: 5000,
            useRegex: false,
          },
          ruleSetJson: null,
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
          materializedAt: expect.any(String),
          materializedPaths: paths,
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

      const setterFn = mockSet.mock.calls[0][0];
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
          ruleSetJson: null,
        },
        selectionVersion: state.selectionVersion + 1,
      });
    });

    it('increments selectionVersion from the updater state to avoid lost concurrent bumps', () => {
      const staleState = createMockState({ selectionVersion: 2 });
      const liveState = createMockState({ selectionVersion: 7 });
      const mockGet = vi.fn(() => staleState);
      const actions = createSelectionModelActions(mockSet, mockGet);
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

      const setterFn = mockSet.mock.calls[0][0];
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
          ruleSetJson: null,
        },
      });
      const mockGet = vi.fn(() => currentState);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setQuerySelectionManifest(currentState.querySelectionManifest);

      const setterFn = mockSet.mock.calls[0][0];
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
          ruleSetJson: null,
        },
      });
      const mockGet = vi.fn(() => currentState);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setQuerySelectionManifest({
        directoryCounts: new Map([['/src', 2]]),
        errorMessage: null,
        filePaths: ['/src/index.ts', '/src/utils.ts'],
        fingerprint: 'fp-new',
        pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
        snapshotId: 'snapshot-new',
        status: 'ready',
      });

      const setterFn = mockSet.mock.calls[0][0];
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
          ruleSetJson: null,
        },
      });
      const mockGet = vi.fn(() => currentState);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setQuerySelectionManifest({
        directoryCounts: new Map([['/src', 2]]),
        errorMessage: null,
        filePaths: ['/src/index.ts', '/src/utils.ts'],
        fingerprint: 'fp-1',
        pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
        snapshotId: 'snapshot-1',
        status: 'ready',
      });

      const setterFn = mockSet.mock.calls[0][0];
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
          ruleSetJson: null,
        },
      });
      const mockGet = vi.fn(() => currentState);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setQuerySelectionManifest({
        directoryCounts: new Map([['/src', 2]]),
        errorMessage: null,
        filePaths: ['/src/utils.ts', '/src/index.ts'],
        fingerprint: 'fp-1',
        pathSet: new Set(['/src/utils.ts', '/src/index.ts']),
        snapshotId: 'snapshot-1',
        status: 'ready',
      });

      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(currentState);

      expect(result).not.toBe(currentState);
      expect(result.querySelectionManifest?.filePaths).toEqual(['/src/utils.ts', '/src/index.ts']);
    });
  });
});
