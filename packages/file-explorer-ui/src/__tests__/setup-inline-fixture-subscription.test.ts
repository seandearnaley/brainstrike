import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { FileExplorerState } from '@brainstrike/types';
import { createEmptySelectionModel, DEFAULT_STATE } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { setupInlineFixtureSubscription } from '../setup-inline-fixture-subscription';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: () => loggerMocks,
  };
});

function createFixtureCapableAdapter(
  overrides: Partial<FileSystemAdapter> & {
    clearInlineFixture?: () => Promise<void>;
    isInlineFixtureActive?: () => boolean;
    loadInlineFixture?: () => Promise<FileSystemDirectoryHandle>;
  } = {}
): FileSystemAdapter {
  return {
    requestDirectoryAccess: vi.fn(),
    readDirectory: vi.fn(),
    readFile: vi.fn(),
    exists: vi.fn(),
    loadInlineFixture:
      overrides.loadInlineFixture ?? vi.fn(async () => ({}) as FileSystemDirectoryHandle),
    clearInlineFixture: overrides.clearInlineFixture ?? vi.fn(async () => undefined),
    isInlineFixtureActive: overrides.isInlineFixtureActive ?? vi.fn(() => false),
    ...overrides,
  } as unknown as FileSystemAdapter;
}

function createFixtureStore(initialEnabled: boolean) {
  return createStore<FileExplorerState>()((set) => ({
    ...(DEFAULT_STATE as FileExplorerState),
    currentFolderId: null,
    folderStates: {},
    folderAccessOrder: [],
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
    selectionModel: createEmptySelectionModel(),
    devInlineFixtureEnabled: initialEnabled,
    setRootDirectoryHandle: (handle) => set({ rootDirectoryHandle: handle }),
    setDevInlineFixtureEnabled: (value) => set({ devInlineFixtureEnabled: value }),
    setCurrentFolderId: vi.fn(),
    hydrateFolderState: vi.fn(),
    setSelectedFiles: vi.fn(),
    addSelectedFile: vi.fn(),
    removeSelectedFile: vi.fn(),
    toggleSelectedFile: vi.fn(),
    clearSelectedFiles: vi.fn(),
    addMultipleSelectedFiles: vi.fn(),
    removeMultipleSelectedFiles: vi.fn(),
    addMultipleSelectedFilesChunked: vi.fn(),
    setExpandedPaths: vi.fn(),
    toggleDirectoryExpansion: vi.fn(),
    setFilters: vi.fn(),
    setUseRegex: vi.fn(),
    setIncludeProjectTree: vi.fn(),
    setFolderSummaryThreshold: vi.fn(),
    setMaxSelectionCount: vi.fn(),
    setLastActiveTab: vi.fn(),
    expandAllDirectories: vi.fn(),
    collapseAllDirectories: vi.fn(),
    setFileContent: vi.fn(),
    clearFileContents: vi.fn(),
    clearAllFileContents: vi.fn(),
    setQuickFilter: vi.fn(),
    clearQuickFilter: vi.fn(),
    setIsAccessLoading: vi.fn(),
    setFiltersExpanded: vi.fn(),
    setSelectionMode: vi.fn(),
    setSelectionRules: vi.fn(),
    setMaterializedRuleSelection: vi.fn(),
    commitRulesToExplicit: vi.fn(),
    setQuerySelection: vi.fn(),
    setQuerySelectionManifest: vi.fn(),
    setViewFilterPresetId: vi.fn(),
    addFilter: vi.fn(),
    removeFilter: vi.fn(),
    toggleFilterEnabled: vi.fn(),
  }));
}

describe('setup-inline-fixture-subscription', () => {
  beforeEach(() => {
    loggerMocks.debug.mockReset();
    loggerMocks.error.mockReset();
    loggerMocks.info.mockReset();
    loggerMocks.warn.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs and contains rollback failures instead of leaking an unhandled rejection', async () => {
    const adapter = createFixtureCapableAdapter({
      loadInlineFixture: vi.fn(async () => {
        throw new Error('fixture failed');
      }),
      isInlineFixtureActive: () => false,
    });
    const store = createFixtureStore(true);

    store.setState({
      setDevInlineFixtureEnabled: () => {
        throw new Error('rollback exploded');
      },
    });

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);
    await Promise.resolve();
    await Promise.resolve();

    expect(loggerMocks.warn).toHaveBeenCalledWith('Failed to toggle inline fixture', {
      error: expect.any(Error),
      enabled: true,
    });
    expect(loggerMocks.error).toHaveBeenCalledWith(
      'Inline fixture toggle crashed outside guarded flow',
      {
        error: expect.any(Error),
        enabled: true,
      }
    );

    unsubscribe();
  });
});
