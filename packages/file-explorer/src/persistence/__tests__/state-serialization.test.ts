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
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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
    selectedFilePaths: new Set(),
    expandedDirectoryPaths: new Set(),
    folderStates: {},
    folderAccessOrder: [],
    selectionModel: createEmptySelectionModel(),
    ...overrides,
  };
}

describe('state-serialization', () => {
  it('preserves the current folder fallback entry with expansion and filter state', () => {
    const state = buildState({
      currentFolderId: 'folder-1',
      selectedFilePaths: new Set(['folder-1|@|src/index.ts']),
      expandedDirectoryPaths: new Set(['/src', '/src/utils']),
      includeFilters: ['**/*.ts'],
      excludeFilters: ['**/*.test.ts'],
      useRegex: true,
      includeProjectTree: false,
      tokenBudget: 250,
      folderSummaryThreshold: 12,
      maxSelectionCount: 999,
      lastActiveTab: 'preview',
      viewFilterPresetId: 'ts-js',
      folderStates: {},
    });

    const result = serializeState(state);

    expect(result.folderStates['folder-1']).toEqual(
      expect.objectContaining({
        selectedFilePaths: ['folder-1|@|src/index.ts'],
        expandedDirectoryPaths: ['/src', '/src/utils'],
        includeFilters: ['**/*.ts'],
        excludeFilters: ['**/*.test.ts'],
        useRegex: true,
        includeProjectTree: false,
        tokenBudget: 250,
        folderSummaryThreshold: 12,
        maxSelectionCount: 999,
        lastActiveTab: 'preview',
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
        selectedFilePaths: new Set(),
        expandedDirectoryPaths: new Set(),
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
        selectedFilePaths: new Set(['sel1']),
        expandedDirectoryPaths: new Set(['exp1']),
        folderStates: {
          'folder-1': {
            selectedFilePaths: new Set(),
            expandedDirectoryPaths: new Set(),
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: true,
            tokenBudget: 100,
            folderSummaryThreshold: 50,
            maxSelectionCount: 100,
            lastActiveTab: 'files',
            lastAccessed: 0,
            viewFilterPresetId: null,
          },
        },
      });

      const result = serializeState(state);

      // The current folder's state should be synced from top-level
      expect(result.folderStates['folder-1']?.selectedFilePaths).toEqual(['sel1']);
      expect(result.folderStates['folder-1']?.expandedDirectoryPaths).toEqual(['exp1']);
    });

    it('should create a new folderState entry when currentFolderId is not in folderStates', () => {
      const state = buildState({
        currentFolderId: 'new-folder',
        selectedFilePaths: new Set(['file1']),
        expandedDirectoryPaths: new Set(['dir1']),
        folderStates: {}, // No entry for 'new-folder'
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
        selectedFilePaths: new Set(['orphan']),
        folderStates: {},
      });

      const result = serializeState(state);

      // No folder state should be created
      expect(Object.keys(result.folderStates)).toHaveLength(0);
      expect(result.selectedFilePaths).toEqual(['orphan']);
    });

    it('should serialize selectionModel with materializedPaths', () => {
      const state = buildState({
        selectionModel: {
          mode: 'rules',
          explicitPaths: new Set(['a', 'b']),
          ruleSetJson: '{"rules":[]}',
          materializedPaths: new Set(['m1', 'm2']),
          materializedAt: '2024-01-01T00:00:00Z',
        },
      });

      const result = serializeState(state);

      expect(result.selectionModel).toEqual({
        mode: 'rules',
        explicitPaths: ['a', 'b'],
        ruleSetJson: '{"rules":[]}',
        materializedPaths: ['m1', 'm2'],
        materializedAt: '2024-01-01T00:00:00Z',
      });
    });

    it('should serialize selectionModel with null materializedPaths', () => {
      const state = buildState({
        selectionModel: {
          mode: 'explicit',
          explicitPaths: new Set(['x']),
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
          queryDescriptor: null,
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
          mode: 'query',
          explicitPaths: new Set(),
          ruleSetJson: null,
          materializedPaths: new Set(['src/index.ts']),
          materializedAt: '2024-01-01T00:00:00Z',
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

      const result = serializeState(state);

      expect(result.selectionModel).toEqual({
        mode: 'query',
        explicitPaths: [],
        ruleSetJson: null,
        materializedPaths: ['src/index.ts'],
        materializedAt: '2024-01-01T00:00:00Z',
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
      });
    });

    it('should coerce non-finite numbers to fallbacks during merge', () => {
      const current = buildState({
        tokenBudget: 1234,
      });
      const persisted = {
        tokenBudget: Number.NaN,
        folderStates: {
          root: {
            tokenBudget: Number.POSITIVE_INFINITY,
          },
        },
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
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: ['sel'],
        expandedDirectoryPaths: ['exp'],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 200,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'preview',
        quickFilter: 'test',
        devInlineFixtureEnabled: true,
        isFiltersExpanded: true,
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
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
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
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 'not-a-number' as unknown as number,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
      } as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.tokenBudget).toBe(999);
    });

    it('should coerce non-string quickFilter to current default', () => {
      const current = buildState({ quickFilter: 'default-filter' });
      const persisted = {
        currentFolderId: null,
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: 42 as unknown as string,
        devInlineFixtureEnabled: false,
      } as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.quickFilter).toBe('default-filter');
    });

    it('should coerce non-boolean devInlineFixtureEnabled to current default', () => {
      const current = buildState({ devInlineFixtureEnabled: true });
      const persisted = {
        currentFolderId: null,
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: 'yes' as unknown as boolean,
      } as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.devInlineFixtureEnabled).toBe(true);
    });

    it('should coerce non-boolean isFiltersExpanded to current default', () => {
      const current = buildState({ isFiltersExpanded: true });
      const persisted = {
        currentFolderId: null,
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
        isFiltersExpanded: 123 as unknown as boolean,
      } as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.isFiltersExpanded).toBe(true);
    });

    it('should coerce non-boolean isFilterChipsVisible to current default', () => {
      const current = buildState({ isFilterChipsVisible: true });
      const persisted = {
        currentFolderId: null,
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
        isFilterChipsVisible: 'nope' as unknown as boolean,
      } as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.isFilterChipsVisible).toBe(true);
    });

    it('should coerce non-array selectedFilePaths to empty array', () => {
      const current = buildState();
      const persisted = {
        currentFolderId: null,
        folderStates: {},
        folderAccessOrder: 'not-array' as unknown as string[],
        selectedFilePaths: 'not-array' as unknown as string[],
        expandedDirectoryPaths: 123 as unknown as string[],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
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
        folderStates: {},
        folderAccessOrder: ['valid', 42, null, 'also-valid'] as unknown as string[],
        selectedFilePaths: ['file1', undefined, 'file2'] as unknown as string[],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
      } as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.selectedFilePaths).toEqual(new Set(['file1', 'file2']));
      expect(result.folderAccessOrder).toEqual(['valid', 'also-valid']);
    });

    it('should coerce non-number tokenBudget in folderState to fallback', () => {
      const current = buildState({ tokenBudget: 500 });
      const persisted: SerializedState = {
        currentFolderId: null,
        folderStates: {
          'folder-1': {
            selectedFilePaths: [],
            expandedDirectoryPaths: [],
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: false,
            tokenBudget: 'bad' as unknown as number,
            folderSummaryThreshold: 10,
            maxSelectionCount: 50,
            lastActiveTab: 'files',
            lastAccessed: 0,
          },
        },
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 500,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
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
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
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
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
        selectionModel: {
          mode: 'rules',
          explicitPaths: ['a', 'b'],
          ruleSetJson: '{"rules":[]}',
          materializedPaths: ['m1'],
          materializedAt: '2024-01-01',
        },
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
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
        selectionModel: {
          mode: 'query',
          explicitPaths: [],
          ruleSetJson: null,
          materializedPaths: ['src/index.ts'],
          materializedAt: '2024-01-01',
          queryDescriptor: {
            kind: 'recursive-folder',
            folderId: 'folder1',
            rootPath: 'src',
            coveredDirectoryPaths: ['src'],
            includeFilters: ['**/*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: null,
            manifestSnapshotId: null,
            useRegex: false,
            totalSelectedCount: 2500,
          },
        },
      };

      const result = mergeState(persisted, current, false);

      expect(result.selectionModel.mode).toBe('query');
      expect(result.selectionModel.explicitPaths).toEqual(new Set());
      expect(result.selectionModel.materializedPaths).toEqual(new Set(['src/index.ts']));
      expect(result.selectionModel.queryDescriptor).toEqual({
        kind: 'recursive-folder',
        folderId: 'folder1',
        rootPath: 'src',
        coveredDirectoryPaths: ['src'],
        includeFilters: ['**/*.ts'],
        excludeFilters: [],
        includedPaths: [],
        excludedPaths: [],
        manifestFingerprint: null,
        manifestSnapshotId: null,
        useRegex: false,
        totalSelectedCount: 2500,
      });
    });

    it('drops malformed query descriptor arrays and coerces invalid fields during deserialize', () => {
      const current = buildState();
      const persisted = {
        currentFolderId: 'folder1',
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
        selectionModel: {
          mode: 'query',
          explicitPaths: [],
          ruleSetJson: null,
          materializedPaths: ['src/index.ts', 42],
          materializedAt: '2024-01-01',
          queryDescriptor: {
            kind: 'recursive-folder',
            folderId: 'folder1',
            rootPath: 123,
            coveredDirectoryPaths: ['src', 7],
            includeFilters: ['**/*.ts', false],
            excludeFilters: [null],
            includedPaths: ['src/index.ts', {}],
            excludedPaths: [99],
            manifestFingerprint: 42,
            manifestSnapshotId: {},
            useRegex: 'yes',
            totalSelectedCount: 'bad-count',
          },
        },
      } as unknown as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.selectionModel.mode).toBe('query');
      expect(result.selectionModel.materializedPaths).toEqual(new Set(['src/index.ts']));
      expect(result.selectionModel.queryDescriptor).toEqual({
        kind: 'recursive-folder',
        folderId: 'folder1',
        rootPath: null,
        coveredDirectoryPaths: ['src'],
        includeFilters: ['**/*.ts'],
        excludeFilters: [],
        includedPaths: ['src/index.ts'],
        excludedPaths: [],
        manifestFingerprint: null,
        manifestSnapshotId: null,
        useRegex: false,
        totalSelectedCount: 0,
      });
    });

    it('truncates oversized persisted string arrays during deserialize', () => {
      const current = buildState();
      const oversizedPaths = Array.from({ length: 50_100 }, (_, index) => `src/file-${index}.ts`);
      const persisted = {
        currentFolderId: 'folder1',
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: oversizedPaths,
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
      } as unknown as SerializedState;

      const result = mergeState(persisted, current, false);

      expect(result.selectedFilePaths.size).toBe(50_000);
    });

    it('falls back to explicit mode when a persisted query descriptor is malformed', () => {
      mockLogger.warn.mockClear();
      const current = buildState();
      const persisted = {
        currentFolderId: 'folder1',
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: ['folder1|@|src/index.ts'],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
        selectionModel: {
          mode: 'query',
          explicitPaths: ['folder1|@|src/index.ts'],
          ruleSetJson: null,
          materializedPaths: ['src/index.ts'],
          materializedAt: '2024-01-01',
          queryDescriptor: {
            kind: 'unknown-kind',
            folderId: 42,
            totalSelectedCount: 'bad-count',
          },
        },
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
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
        selectionModel: {
          mode: 'explicit',
          explicitPaths: ['x'],
          ruleSetJson: null,
          materializedPaths: null,
          materializedAt: null,
        },
      };

      const result = mergeState(persisted, current, false);

      expect(result.selectionModel.mode).toBe('explicit');
      expect(result.selectionModel.materializedPaths).toBeNull();
    });

    it('should handle selectionModel with null ruleSetJson and materializedAt', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: null,
        folderStates: {},
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
        selectionModel: {
          mode: 'explicit',
          explicitPaths: [],
          ruleSetJson: undefined as unknown as null,
          materializedPaths: null,
          materializedAt: undefined as unknown as null,
        },
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
        folderStates: {
          'folder-1': {
            selectedFilePaths: [], // Empty in folder state
            expandedDirectoryPaths: [], // Empty in folder state
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: false,
            tokenBudget: 100,
            folderSummaryThreshold: 10,
            maxSelectionCount: 50,
            lastActiveTab: 'files',
            lastAccessed: 0,
          },
        },
        folderAccessOrder: [],
        selectedFilePaths: ['top-level-sel'], // Has selections
        expandedDirectoryPaths: ['top-level-exp'], // Has expansions
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
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
        folderStates: {
          'folder-1': {
            selectedFilePaths: ['folder-sel'], // Has its own selections
            expandedDirectoryPaths: ['folder-exp'],
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: false,
            tokenBudget: 100,
            folderSummaryThreshold: 10,
            maxSelectionCount: 50,
            lastActiveTab: 'files',
            lastAccessed: 0,
          },
        },
        folderAccessOrder: [],
        selectedFilePaths: ['top-level-sel'],
        expandedDirectoryPaths: ['top-level-exp'],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
      };

      const result = mergeState(persisted, current, false);

      // Should use folder-level selections (not top-level) since folder has its own
      expect(result.folderStates['folder-1']?.selectedFilePaths).toEqual(new Set(['folder-sel']));
    });

    it('should not use top-level selections for non-current folders', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: 'folder-1',
        folderStates: {
          'folder-1': {
            selectedFilePaths: ['f1-sel'],
            expandedDirectoryPaths: [],
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: false,
            tokenBudget: 100,
            folderSummaryThreshold: 10,
            maxSelectionCount: 50,
            lastActiveTab: 'files',
            lastAccessed: 0,
          },
          'folder-2': {
            selectedFilePaths: [], // Empty but NOT the current folder
            expandedDirectoryPaths: [],
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: false,
            tokenBudget: 100,
            folderSummaryThreshold: 10,
            maxSelectionCount: 50,
            lastActiveTab: 'files',
            lastAccessed: 0,
          },
        },
        folderAccessOrder: [],
        selectedFilePaths: ['top-level-sel'],
        expandedDirectoryPaths: ['top-level-exp'],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 50,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
      };

      const result = mergeState(persisted, current, false);

      // folder-2 is NOT the current folder, so it should keep its empty selections
      expect(result.folderStates['folder-2']?.selectedFilePaths).toEqual(new Set());
    });

    it('should prefer the top-level query selection model for the current folder even when explicit selections are empty', () => {
      const current = buildState();
      const persisted: SerializedState = {
        currentFolderId: 'folder-1',
        folderStates: {
          'folder-1': {
            selectedFilePaths: [],
            selectionModel: {
              mode: 'explicit',
              explicitPaths: [],
              ruleSetJson: null,
              materializedPaths: null,
              materializedAt: null,
              queryDescriptor: null,
            },
            expandedDirectoryPaths: [],
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            includeProjectTree: false,
            tokenBudget: 100,
            folderSummaryThreshold: 10,
            maxSelectionCount: 1000,
            lastActiveTab: 'files',
            lastAccessed: 0,
          },
        },
        folderAccessOrder: [],
        selectedFilePaths: [],
        expandedDirectoryPaths: [],
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: false,
        tokenBudget: 100,
        folderSummaryThreshold: 10,
        maxSelectionCount: 1000,
        lastActiveTab: 'files',
        quickFilter: '',
        devInlineFixtureEnabled: false,
        selectionModel: {
          mode: 'query',
          explicitPaths: [],
          ruleSetJson: null,
          materializedPaths: ['file-0.ts'],
          materializedAt: '2024-01-01T00:00:00Z',
          queryDescriptor: {
            kind: 'recursive-select-all',
            folderId: 'folder-1',
            rootPath: null,
            coveredDirectoryPaths: [],
            includeFilters: ['*.ts'],
            excludeFilters: [],
            includedPaths: [],
            excludedPaths: [],
            manifestFingerprint: 'fingerprint',
            manifestSnapshotId: 'snapshot-id',
            useRegex: false,
            totalSelectedCount: 600,
          },
        },
      };

      const result = mergeState(persisted, current, false);

      expect(result.folderStates['folder-1']?.selectionModel.mode).toBe('query');
      expect(
        result.folderStates['folder-1']?.selectionModel.queryDescriptor?.totalSelectedCount
      ).toBe(600);
    });
  });
});
