/**
 * State Serialization Branch Coverage Tests
 *
 * Tests focused on covering uncovered branches in state-serialization.ts:
 * - WeakMap cache hit path in cachedSetToArray
 * - coercion edge cases (non-array, non-number, non-string, non-boolean)
 * - shouldLog=false paths in mergeState
 * - deserializeSelectionModel edge cases
 * - serializeState with currentFolderId not in folderStates (creates new entry)
 */

import type { FileExplorerState, SerializedState } from '@brainstrike/types';
import { createEmptySelectionModel, DEFAULT_STATE } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { mergeState, serializeState } from '../state-serialization';

// Mock the logger
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

/** Helper to build a minimal FileExplorerState for testing. */
function buildState(overrides: Partial<FileExplorerState> = {}): FileExplorerState {
  return {
    ...(DEFAULT_STATE as FileExplorerState),
    currentFolderId: null,
    expandedDirectoryPaths: new Set(),
    folderAccessOrder: [],
    folderStates: {},
    selectedFilePaths: new Set(),
    selectionModel: createEmptySelectionModel(),
    ...overrides,
  };
}

describe('state-serialization', () => {
  it('preserves the current folder fallback entry with expansion and filter state', () => {
    const state = buildState({
      currentFolderId: 'folder-1',
      excludeFilters: ['**/*.test.ts'],
      expandedDirectoryPaths: new Set(['/src', '/src/utils']),
      folderStates: {},
      folderSummaryThreshold: 12,
      includeFilters: ['**/*.ts'],
      includeProjectTree: false,
      lastActiveTab: 'preview',
      maxSelectionCount: 999,
      selectedFilePaths: new Set(['folder-1|@|src/index.ts']),
      tokenBudget: 250,
      useRegex: true,
      viewFilterPresetId: 'ts-js',
    });

    const result = serializeState(state);

    expect(result.folderStates['folder-1']).toEqual(
      expect.objectContaining({
        excludeFilters: ['**/*.test.ts'],
        expandedDirectoryPaths: ['/src', '/src/utils'],
        folderSummaryThreshold: 12,
        includeFilters: ['**/*.ts'],
        includeProjectTree: false,
        lastActiveTab: 'preview',
        maxSelectionCount: 999,
        selectedFilePaths: ['folder-1|@|src/index.ts'],
        tokenBudget: 250,
        useRegex: true,
        viewFilterPresetId: 'ts-js',
      })
    );
  });

  describe('cachedSetToArray – WeakMap cache hit', () => {
    it('should return the cached array on the second serialization with the same Set reference', () => {
      // The WeakMap cache is module-level state. Calling serializeState twice with the
      // same Set reference should hit the cache on the second call.
      const sharedSet = new Set(['a', 'b', 'c']);
      const state = buildState({
        selectedFilePaths: sharedSet,
      });

      const first = serializeState(state);
      const second = serializeState(state);

      // Both calls should produce the same array content
      expect(first.selectedFilePaths).toEqual(['a', 'b', 'c']);
      expect(second.selectedFilePaths).toEqual(['a', 'b', 'c']);

      // The cached path returns the exact same array reference
      expect(first.selectedFilePaths).toBe(second.selectedFilePaths);
    });

    it('should return empty array for undefined or empty sets', () => {
      const state = buildState({
        expandedDirectoryPaths: new Set(),
        selectedFilePaths: new Set(),
      });

      const result = serializeState(state);

      expect(result.selectedFilePaths).toEqual([]);
      expect(result.expandedDirectoryPaths).toEqual([]);
    });
  });

  describe('serializeState – currentFolderId branch coverage', () => {
    it('should update existing folderState for the current folder', () => {
      const state = buildState({
        currentFolderId: 'folder-1',
        expandedDirectoryPaths: new Set(['exp1']),
        folderStates: {
          'folder-1': {
            excludeFilters: [],
            expandedDirectoryPaths: new Set(),
            folderSummaryThreshold: 50,
            includeFilters: [],
            includeProjectTree: true,
            lastAccessed: 0,
            lastActiveTab: 'files',
            maxSelectionCount: 100,
            selectedFilePaths: new Set(),
            selectionModel: createEmptySelectionModel(),
            tokenBudget: 100,
            useRegex: false,
            viewFilterPresetId: null,
          },
        },
        selectedFilePaths: new Set(['sel1']),
      });

      const result = serializeState(state);

      // The current folder's state should be synced from top-level
      expect(result.folderStates['folder-1']?.selectedFilePaths).toEqual(['sel1']);
      expect(result.folderStates['folder-1']?.expandedDirectoryPaths).toEqual(['exp1']);
    });

    it('should create a new folderState entry when currentFolderId is not in folderStates', () => {
      const state = buildState({
        currentFolderId: 'new-folder',
        expandedDirectoryPaths: new Set(['dir1']),
        folderStates: {}, // No entry for 'new-folder'
        selectedFilePaths: new Set(['file1']),
      });

      const result = serializeState(state);

      // Should create a new entry for the current folder
      expect(result.folderStates['new-folder']).toBeDefined();
      expect(result.folderStates['new-folder']?.selectedFilePaths).toEqual(['file1']);
      expect(result.folderStates['new-folder']?.expandedDirectoryPaths).toEqual(['dir1']);
    });

    it('should handle null currentFolderId (no folder sync)', () => {
      const state = buildState({
        currentFolderId: null,
        folderStates: {},
        selectedFilePaths: new Set(['orphan']),
      });

      const result = serializeState(state);

      // No folder state should be created
      expect(Object.keys(result.folderStates)).toHaveLength(0);
      expect(result.selectedFilePaths).toEqual(['orphan']);
    });

    it('should serialize selectionModel with materializedPaths', () => {
      const state = buildState({
        selectionModel: {
          explicitPaths: new Set(['a', 'b']),
          materializedAt: '2024-01-01T00:00:00Z',
          materializedPaths: new Set(['m1', 'm2']),
          mode: 'rules',
          queryDescriptor: null,
          ruleSetJson: '{"rules":[]}',
        },
      });

      const result = serializeState(state);

      expect(result.selectionModel).toEqual({
        explicitPaths: ['a', 'b'],
        materializedAt: '2024-01-01T00:00:00Z',
        materializedPaths: ['m1', 'm2'],
        mode: 'rules',
        queryDescriptor: null,
        ruleSetJson: '{"rules":[]}',
      });
    });

    it('should serialize selectionModel with null materializedPaths', () => {
      const state = buildState({
        selectionModel: {
          explicitPaths: new Set(['x']),
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
          ruleSetJson: null,
        },
      });

      const result = serializeState(state);

      expect(result.selectionModel?.materializedPaths).toBeNull();
      expect(result.selectionModel?.materializedAt).toBeNull();
    });

    it('should serialize query-backed selection descriptors without persisting giant explicit selections', () => {
      const state = buildState({
        selectedFilePaths: new Set(['folder1|@|src/index.ts']),
        selectionModel: {
          explicitPaths: new Set(),
          materializedAt: '2024-01-01T00:00:00Z',
          materializedPaths: new Set(['src/index.ts']),
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

      const result = serializeState(state);

      expect(result.selectionModel).toEqual({
        explicitPaths: [],
        materializedAt: '2024-01-01T00:00:00Z',
        materializedPaths: ['src/index.ts'],
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
      });
    });

    it('should coerce non-finite numbers to fallbacks during merge', () => {
      const current = buildState({
        tokenBudget: 1234,
      });
      const persisted = {
        folderStates: {
          root: {
            tokenBudget: Number.POSITIVE_INFINITY,
          },
        },
        tokenBudget: Number.NaN,
      } as unknown as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.tokenBudget).toBe(1234);
      expect(result.folderStates['root']?.tokenBudget).toBe(1234);
    });
  });

  describe('mergeState – shouldLog=false paths', () => {
    it('should skip logging when shouldLog is false and persisted is null', () => {
      const current = buildState();

      const result = mergeState(null, current, false);

      // Should return current state without logging
      expect(result).toBe(current);
    });

    it('should skip logging when shouldLog is false and persisted is valid', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: 'f1',
        devInlineFixtureEnabled: true,
        excludeFilters: [],
        expandedDirectoryPaths: ['exp'],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        isFiltersExpanded: true,
        lastActiveTab: 'preview',
        maxSelectionCount: 50,
        quickFilter: 'test',
        selectedFilePaths: ['sel'],
        tokenBudget: 200,
        useRegex: false,
      };

      const result = mergeState(persisted, current, false);

      // Should still merge correctly
      expect(result.currentFolderId).toBe('f1');
      expect(result.selectedFilePaths).toEqual(new Set(['sel']));
      expect(result.lastActiveTab).toBe('preview');
    });

    it('should log when shouldLog is true and persisted is null', () => {
      const current = buildState();

      const result = mergeState(null, current, true);

      expect(result).toBe(current);
    });

    it('should log when shouldLog is true with valid persisted state', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: 'f1',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: [],
        tokenBudget: 100,
        useRegex: false,
      };

      const result = mergeState(persisted, current, true);

      expect(result.currentFolderId).toBe('f1');
    });
  });

  describe('mergeState – coercion edge cases', () => {
    it('should coerce non-number tokenBudget to current default', () => {
      const current = buildState({ tokenBudget: 999 });
      const persisted = {
        currentFolderId: null,
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: [],
        tokenBudget: 'not-a-number' as unknown as number,
        useRegex: false,
      } as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.tokenBudget).toBe(999);
    });

    it('should coerce non-string quickFilter to current default', () => {
      const current = buildState({ quickFilter: 'default-filter' });
      const persisted = {
        currentFolderId: null,
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: 42 as unknown as string,
        selectedFilePaths: [],
        tokenBudget: 100,
        useRegex: false,
      } as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.quickFilter).toBe('default-filter');
    });

    it('should coerce non-boolean devInlineFixtureEnabled to current default', () => {
      const current = buildState({ devInlineFixtureEnabled: true });
      const persisted = {
        currentFolderId: null,
        devInlineFixtureEnabled: 'yes' as unknown as boolean,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: [],
        tokenBudget: 100,
        useRegex: false,
      } as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.devInlineFixtureEnabled).toBe(true);
    });

    it('should coerce non-boolean isFiltersExpanded to current default', () => {
      const current = buildState({ isFiltersExpanded: true });
      const persisted = {
        currentFolderId: null,
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        isFiltersExpanded: 123 as unknown as boolean,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: [],
        tokenBudget: 100,
        useRegex: false,
      } as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.isFiltersExpanded).toBe(true);
    });

    it('should coerce non-boolean isFilterChipsVisible to current default', () => {
      const current = buildState({ isFilterChipsVisible: true });
      const persisted = {
        currentFolderId: null,
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        isFilterChipsVisible: 'nope' as unknown as boolean,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: [],
        tokenBudget: 100,
        useRegex: false,
      } as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.isFilterChipsVisible).toBe(true);
    });

    it('should coerce non-array selectedFilePaths to empty array', () => {
      const current = buildState();
      const persisted = {
        currentFolderId: null,
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: 123 as unknown as string[],
        folderAccessOrder: 'not-array' as unknown as string[],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: 'not-array' as unknown as string[],
        tokenBudget: 100,
        useRegex: false,
      } as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.selectedFilePaths).toEqual(new Set());
      expect(result.expandedDirectoryPaths).toEqual(new Set());
      expect(result.folderAccessOrder).toEqual([]);
    });

    it('should filter non-string items from arrays', () => {
      const current = buildState();
      const persisted = {
        currentFolderId: null,
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: ['valid', 42, null, 'also-valid'] as unknown as string[],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: ['file1', undefined, 'file2'] as unknown as string[],
        tokenBudget: 100,
        useRegex: false,
      } as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.selectedFilePaths).toEqual(new Set(['file1', 'file2']));
      expect(result.folderAccessOrder).toEqual(['valid', 'also-valid']);
    });

    it('should coerce non-number tokenBudget in folderState to fallback', () => {
      const current = buildState({ tokenBudget: 500 });
      const persisted: SerializedState = {
        currentFolderId: null,
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {
          'folder-1': {
            excludeFilters: [],
            expandedDirectoryPaths: [],
            folderSummaryThreshold: 10,
            includeFilters: [],
            includeProjectTree: false,
            lastAccessed: 0,
            lastActiveTab: 'files',
            maxSelectionCount: 50,
            selectedFilePaths: [],
            tokenBudget: 'bad' as unknown as number,
            useRegex: false,
          },
        },
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: [],
        tokenBudget: 500,
        useRegex: false,
      };

      const result = mergeState(persisted, current, false);

      expect(result.folderStates['folder-1']?.tokenBudget).toBe(500);
    });
  });

  describe('mergeState – deserializeSelectionModel edge cases', () => {
    it('should return empty selection model when selectionModel is undefined', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: null,
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: [],
        tokenBudget: 100,
        useRegex: false,
        // selectionModel is intentionally omitted
      };

      const result = mergeState(persisted, current, false);

      expect(result.selectionModel.mode).toBe('explicit');
      expect(result.selectionModel.explicitPaths).toEqual(new Set());
      expect(result.selectionModel.ruleSetJson).toBeNull();
      expect(result.selectionModel.materializedPaths).toBeNull();
      expect(result.selectionModel.materializedAt).toBeNull();
    });

    it('should deserialize rules mode selectionModel', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: null,
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: [],
        selectionModel: {
          explicitPaths: ['a', 'b'],
          materializedAt: '2024-01-01',
          materializedPaths: ['m1'],
          mode: 'rules',
          queryDescriptor: null,
          ruleSetJson: '{"rules":[]}',
        },
        tokenBudget: 100,
        useRegex: false,
      };

      const result = mergeState(persisted, current, false);

      expect(result.selectionModel.mode).toBe('rules');
      expect(result.selectionModel.explicitPaths).toEqual(new Set(['a', 'b']));
      expect(result.selectionModel.ruleSetJson).toBe('{"rules":[]}');
      expect(result.selectionModel.materializedPaths).toEqual(new Set(['m1']));
      expect(result.selectionModel.materializedAt).toBe('2024-01-01');
    });

    it('should deserialize query-backed selection descriptors', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: 'folder1',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: [],
        selectionModel: {
          explicitPaths: [],
          materializedAt: '2024-01-01',
          materializedPaths: ['src/index.ts'],
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: ['src'],
            excludedPaths: [],
            excludeFilters: [],
            folderId: 'folder1',
            includedPaths: [],
            includeFilters: ['**/*.ts'],
            kind: 'recursive-folder',
            manifestFingerprint: null,
            manifestSnapshotId: null,
            rootPath: 'src',
            totalSelectedCount: 2500,
            useRegex: false,
          },
          ruleSetJson: null,
        },
        tokenBudget: 100,
        useRegex: false,
      };

      const result = mergeState(persisted, current, false);

      expect(result.selectionModel.mode).toBe('query');
      expect(result.selectionModel.explicitPaths).toEqual(new Set());
      expect(result.selectionModel.materializedPaths).toEqual(new Set(['src/index.ts']));
      expect(result.selectionModel.queryDescriptor).toEqual({
        coveredDirectoryPaths: ['src'],
        excludedPaths: [],
        excludeFilters: [],
        folderId: 'folder1',
        includedPaths: [],
        includeFilters: ['**/*.ts'],
        kind: 'recursive-folder',
        manifestFingerprint: null,
        manifestSnapshotId: null,
        rootPath: 'src',
        totalSelectedCount: 2500,
        useRegex: false,
      });
    });

    it('drops malformed query descriptor arrays and coerces invalid fields during deserialize', () => {
      const current = buildState();
      const persisted = {
        currentFolderId: 'folder1',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: [],
        selectionModel: {
          explicitPaths: [],
          materializedAt: '2024-01-01',
          materializedPaths: ['src/index.ts', 42],
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: ['src', 7],
            excludedPaths: [99],
            excludeFilters: [null],
            folderId: 'folder1',
            includedPaths: ['src/index.ts', {}],
            includeFilters: ['**/*.ts', false],
            kind: 'recursive-folder',
            manifestFingerprint: 42,
            manifestSnapshotId: {},
            rootPath: 123,
            totalSelectedCount: 'bad-count',
            useRegex: 'yes',
          },
          ruleSetJson: null,
        },
        tokenBudget: 100,
        useRegex: false,
      } as unknown as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.selectionModel.mode).toBe('query');
      expect(result.selectionModel.materializedPaths).toEqual(new Set(['src/index.ts']));
      expect(result.selectionModel.queryDescriptor).toEqual({
        coveredDirectoryPaths: ['src'],
        excludedPaths: [],
        excludeFilters: [],
        folderId: 'folder1',
        includedPaths: ['src/index.ts'],
        includeFilters: ['**/*.ts'],
        kind: 'recursive-folder',
        manifestFingerprint: null,
        manifestSnapshotId: null,
        rootPath: null,
        totalSelectedCount: 0,
        useRegex: false,
      });
    });

    it('truncates oversized persisted string arrays during deserialize', () => {
      const current = buildState();
      const oversizedPaths = Array.from({ length: 50_100 }, (_, index) => `src/file-${index}.ts`);
      const persisted = {
        currentFolderId: 'folder1',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: oversizedPaths,
        tokenBudget: 100,
        useRegex: false,
      } as unknown as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.selectedFilePaths.size).toBe(50_000);
    });

    it('falls back to explicit mode when a persisted query descriptor is malformed', () => {
      mockLogger.warn.mockClear();
      const current = buildState();
      const persisted = {
        currentFolderId: 'folder1',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: ['folder1|@|src/index.ts'],
        selectionModel: {
          explicitPaths: ['folder1|@|src/index.ts'],
          materializedAt: '2024-01-01',
          materializedPaths: ['src/index.ts'],
          mode: 'query',
          queryDescriptor: {
            folderId: 42,
            kind: 'unknown-kind',
            totalSelectedCount: 'bad-count',
          },
          ruleSetJson: null,
        },
        tokenBudget: 100,
        useRegex: false,
      } as unknown as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.selectionModel.mode).toBe('explicit');
      expect(result.selectionModel.queryDescriptor).toBeNull();
      expect(result.selectionModel.explicitPaths).toEqual(new Set(['folder1|@|src/index.ts']));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Dropping malformed persisted query selection descriptor during deserialization'
      );
    });

    it('should default mode to explicit when mode is not "rules"', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: null,
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: [],
        selectionModel: {
          explicitPaths: ['x'],
          materializedAt: null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
          ruleSetJson: null,
        },
        tokenBudget: 100,
        useRegex: false,
      };

      const result = mergeState(persisted, current, false);

      expect(result.selectionModel.mode).toBe('explicit');
      expect(result.selectionModel.materializedPaths).toBeNull();
    });

    it('should handle selectionModel with null ruleSetJson and materializedAt', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: null,
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {},
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: [],
        selectionModel: {
          explicitPaths: [],
          materializedAt: undefined as unknown as null,
          materializedPaths: null,
          mode: 'explicit',
          queryDescriptor: null,
          ruleSetJson: undefined as unknown as null,
        },
        tokenBudget: 100,
        useRegex: false,
      };

      const result = mergeState(persisted, current, false);

      expect(result.selectionModel.ruleSetJson).toBeNull();
      expect(result.selectionModel.materializedAt).toBeNull();
    });
  });

  describe('mergeState – folder state top-level sync', () => {
    it('should prefer top-level selections for current folder when folder has empty selections', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: 'folder-1',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: ['top-level-exp'], // Has expansions
        folderAccessOrder: [],
        folderStates: {
          'folder-1': {
            excludeFilters: [],
            expandedDirectoryPaths: [], // Empty in folder state
            folderSummaryThreshold: 10,
            includeFilters: [],
            includeProjectTree: false,
            lastAccessed: 0,
            lastActiveTab: 'files',
            maxSelectionCount: 50,
            selectedFilePaths: [], // Empty in folder state
            tokenBudget: 100,
            useRegex: false,
          },
        },
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: ['top-level-sel'], // Has selections
        tokenBudget: 100,
        useRegex: false,
      };

      const result = mergeState(persisted, current, false);

      // Should use top-level selections for the current folder
      expect(result.folderStates['folder-1']?.selectedFilePaths).toEqual(
        new Set(['top-level-sel'])
      );
      expect(result.folderStates['folder-1']?.expandedDirectoryPaths).toEqual(
        new Set(['top-level-exp'])
      );
    });

    it('should use folder-level selections when folder has its own selections', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: 'folder-1',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: ['top-level-exp'],
        folderAccessOrder: [],
        folderStates: {
          'folder-1': {
            excludeFilters: [],
            expandedDirectoryPaths: ['folder-exp'],
            folderSummaryThreshold: 10,
            includeFilters: [],
            includeProjectTree: false,
            lastAccessed: 0,
            lastActiveTab: 'files',
            maxSelectionCount: 50,
            selectedFilePaths: ['folder-sel'], // Has its own selections
            tokenBudget: 100,
            useRegex: false,
          },
        },
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: ['top-level-sel'],
        tokenBudget: 100,
        useRegex: false,
      };

      const result = mergeState(persisted, current, false);

      // Should use folder-level selections (not top-level) since folder has its own
      expect(result.folderStates['folder-1']?.selectedFilePaths).toEqual(new Set(['folder-sel']));
    });

    it('should not use top-level selections for non-current folders', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: 'folder-1',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: ['top-level-exp'],
        folderAccessOrder: [],
        folderStates: {
          'folder-1': {
            excludeFilters: [],
            expandedDirectoryPaths: [],
            folderSummaryThreshold: 10,
            includeFilters: [],
            includeProjectTree: false,
            lastAccessed: 0,
            lastActiveTab: 'files',
            maxSelectionCount: 50,
            selectedFilePaths: ['f1-sel'],
            tokenBudget: 100,
            useRegex: false,
          },
          'folder-2': {
            excludeFilters: [],
            expandedDirectoryPaths: [],
            folderSummaryThreshold: 10,
            includeFilters: [],
            includeProjectTree: false,
            lastAccessed: 0,
            lastActiveTab: 'files',
            maxSelectionCount: 50,
            selectedFilePaths: [], // Empty but NOT the current folder
            tokenBudget: 100,
            useRegex: false,
          },
        },
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 50,
        quickFilter: '',
        selectedFilePaths: ['top-level-sel'],
        tokenBudget: 100,
        useRegex: false,
      };

      const result = mergeState(persisted, current, false);

      // folder-2 is NOT the current folder, so it should keep its empty selections
      expect(result.folderStates['folder-2']?.selectedFilePaths).toEqual(new Set());
    });

    it('should prefer the top-level query selection model for the current folder even when explicit selections are empty', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: 'folder-1',
        devInlineFixtureEnabled: false,
        excludeFilters: [],
        expandedDirectoryPaths: [],
        folderAccessOrder: [],
        folderStates: {
          'folder-1': {
            excludeFilters: [],
            expandedDirectoryPaths: [],
            folderSummaryThreshold: 10,
            includeFilters: [],
            includeProjectTree: false,
            lastAccessed: 0,
            lastActiveTab: 'files',
            maxSelectionCount: 1000,
            selectedFilePaths: [],
            selectionModel: {
              explicitPaths: [],
              materializedAt: null,
              materializedPaths: null,
              mode: 'explicit',
              queryDescriptor: null,
              ruleSetJson: null,
            },
            tokenBudget: 100,
            useRegex: false,
          },
        },
        folderSummaryThreshold: 10,
        includeFilters: [],
        includeProjectTree: false,
        lastActiveTab: 'files',
        maxSelectionCount: 1000,
        quickFilter: '',
        selectedFilePaths: [],
        selectionModel: {
          explicitPaths: [],
          materializedAt: '2024-01-01T00:00:00Z',
          materializedPaths: ['file-0.ts'],
          mode: 'query',
          queryDescriptor: {
            coveredDirectoryPaths: [],
            excludedPaths: [],
            excludeFilters: [],
            folderId: 'folder-1',
            includedPaths: [],
            includeFilters: ['*.ts'],
            kind: 'recursive-select-all',
            manifestFingerprint: 'fingerprint',
            manifestSnapshotId: 'snapshot-id',
            rootPath: null,
            totalSelectedCount: 600,
            useRegex: false,
          },
          ruleSetJson: null,
        },
        tokenBudget: 100,
        useRegex: false,
      };

      const result = mergeState(persisted, current, false);

      expect(result.folderStates['folder-1']?.selectionModel.mode).toBe('query');
      expect(
        result.folderStates['folder-1']?.selectionModel.queryDescriptor?.totalSelectedCount
      ).toBe(600);
    });
  });
});
