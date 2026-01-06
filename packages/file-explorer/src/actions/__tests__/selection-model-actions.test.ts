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
      selectionModel: createEmptySelectionModel(),
      rootDirectoryHandle: null,
      ...overrides,
    }) as FileExplorerState;

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
    });

    it('should clear materialized cache when rules change', () => {
      const stateWithCache = createMockState({
        selectionModel: {
          mode: 'rules',
          explicitPaths: new Set(),
          ruleSetJson: '{"old":"rules"}',
          materializedPaths: new Set(['path1', 'path2']),
          materializedAt: '2024-01-01T00:00:00Z',
        },
      });
      const mockGet = vi.fn(() => stateWithCache);
      const actions = createSelectionModelActions(mockSet, mockGet);

      actions.setSelectionRules('{"new":"rules"}');

      const setterFn = mockSet.mock.calls[0][0];
      const result = setterFn(stateWithCache);

      expect(result.selectionModel.materializedPaths).toBeNull();
      expect(result.selectionModel.materializedAt).toBeNull();
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
        },
        selectedFilePaths: new Set(['folder1|@|src/file1.ts', 'folder1|@|src/file2.ts']),
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
        },
        selectedFilePaths: new Set(['file1.ts']),
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
  });
});
