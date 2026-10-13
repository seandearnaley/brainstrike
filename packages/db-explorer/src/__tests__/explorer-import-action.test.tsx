import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import { __resetImportSettingsStoreForTests } from '@brainstrike/app-state/stores/import-settings-store';
import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '@brainstrike/app-state/stores/vector-status-ui-store';
import type { EmbeddingSet } from '@brainstrike/db';
import { type CollectionPickerCollection, ThemeProvider } from '@brainstrike/ui';
import { dispatchEmbeddingSetUpdated } from '@brainstrike/utils/browser-events';
import { act, render as renderComponent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExplorerImportAction } from '../components/explorer-import-action';
import {
  __resetImportActivitySnapshotForTests,
  readImportActivitySnapshot,
} from '../import-activity-snapshot';

const {
  mockCollections,
  mockCollectionsFetchError,
  mockDatabase,
  mockUsePGliteDatabase,
  mockImportFiles,
  mockImportServiceState,
  mockRefreshCollectionIndexingStats,
  mockSelectedFilePaths,
  mockUseSelectionActionBarPin,
} = vi.hoisted(() => ({
  mockCollections: { current: [] as CollectionPickerCollection[] },
  mockCollectionsFetchError: { current: null as Error | null },
  mockDatabase: { query: vi.fn() },
  mockImportFiles: vi.fn().mockResolvedValue(undefined),
  mockImportServiceState: {
    // Captured from the service options so tests can fire the service's first
    // progress emission explicitly, the way the real service would.
    emitComplete: null as ((results: unknown[]) => Promise<void>) | null,
    emitProgress: null as (() => void) | null,
    isImporting: false,
    progress: null as Record<string, unknown> | null,
  },
  mockRefreshCollectionIndexingStats: vi.fn().mockResolvedValue(undefined),
  mockSelectedFilePaths: { current: new Set<string>() },
  mockUsePGliteDatabase: vi.fn(),
  mockUseSelectionActionBarPin: vi.fn(),
}));

vi.mock('@brainstrike/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db')>();
  return {
    ...actual,
    refreshCollectionIndexingStats: mockRefreshCollectionIndexingStats,
  };
});

vi.mock('@brainstrike/db/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db/react')>();
  return {
    ...actual,
    useEmbeddingSetsRepository: () => ({}),
    usePGliteDatabase: mockUsePGliteDatabase,
  };
});

vi.mock('@brainstrike/vector-management', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/vector-management')>();
  return {
    ...actual,
    CreateEmbeddingSetDialog: ({
      onSetCreated,
    }: {
      onSetCreated: (newSetId: string, newSet: EmbeddingSet) => void;
    }) => (
      <button
        data-testid="mock-create-embedding-set-dialog"
        onClick={() =>
          onSetCreated('created-set-id', {
            createdAt: '2026-05-03T01:00:00.000Z',
            dimensions: 768,
            distance: 'cosine',
            id: 'created-set-id',
            modelId: 'created-model',
            modelKey: 'local::created-model',
            name: 'Created Collection',
          })
        }
        type="button"
      >
        Finish creating collection
      </button>
    ),
    // The real dialogs announce their outcome through this event; surfaces that
    // do not own the live query keep the shared cache honest by listening.
    DeleteEmbeddingSetDialog: ({ embeddingSet }: { embeddingSet: { id: string } }) => (
      <button
        data-testid="mock-delete-embedding-set-dialog"
        onClick={() => dispatchEmbeddingSetUpdated({ id: embeddingSet.id, reason: 'deleted' })}
        type="button"
      >
        Confirm delete
      </button>
    ),
    // The explorer picker deliberately does NOT mount useCollections (a second
    // instance ping-pongs the shared cache); it reads the store cache and tops
    // it up with this one-shot.
    fetchCollectionsSnapshot: async () => {
      if (mockCollectionsFetchError.current) {
        throw mockCollectionsFetchError.current;
      }
      return mockCollections.current;
    },
    RenameEmbeddingSetDialog: ({ embeddingSet }: { embeddingSet: { id: string } }) => (
      <button
        data-testid="mock-rename-embedding-set-dialog"
        onClick={() =>
          dispatchEmbeddingSetUpdated({
            collection: { ...collection({ id: embeddingSet.id }), name: 'Renamed Collection' },
            id: embeddingSet.id,
            reason: 'updated',
          })
        }
        type="button"
      >
        Confirm rename
      </button>
    ),
  };
});

vi.mock('@brainstrike/app-state/hooks/use-model-registry', () => ({
  useEnsureModelRegistry: vi.fn(),
}));

vi.mock('@brainstrike/app-state/hooks/use-local-runtime-embedding-model-catalog', () => ({
  useLocalRuntimeEmbeddingModelCatalog: () => ({
    catalog: null,
    error: null,
    isLoading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../enhanced-file-import-service', () => ({
  useEnhancedFileImportService: (options: {
    onComplete?: (results: unknown[]) => Promise<void>;
    onProgress?: () => void;
  }) => {
    mockImportServiceState.emitProgress = options.onProgress ?? null;
    mockImportServiceState.emitComplete = options.onComplete ?? null;
    return {
      cancelImport: vi.fn(),
      chunkRepository: null,
      importFiles: mockImportFiles,
      isImporting: mockImportServiceState.isImporting,
      progress: mockImportServiceState.progress,
    };
  },
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorer: () => ({
    fileContents: {},
    fileTree: [],
    unfilteredFileTree: null,
  }),
  useSelectionActionBarPin: mockUseSelectionActionBarPin,
  useSelectionManager: () => ({ selectedFilePaths: mockSelectedFilePaths.current }),
}));

function collection(
  overrides: Partial<CollectionPickerCollection> & { id: string }
): CollectionPickerCollection {
  return {
    category: null,
    chunkCount: 4,
    createdAt: '2026-05-01T00:00:00.000Z',
    description: null,
    dimensions: 768,
    distance: 'cosine',
    embeddingCount: 4,
    fileCount: 2,
    modelId: 'model',
    modelKey: 'local::model',
    name: `Collection ${overrides.id}`,
    tags: null,
    ...overrides,
  };
}

const memoryThemeStorage = {
  getItem: async () => null,
  setItem: async () => undefined,
};

/**
 * Collection rows tint themselves from the resolved theme, so the action needs
 * a ThemeProvider. That provider renders nothing until it has read its stored
 * preference, hence the await.
 */
async function renderAction(ui: ReactElement): Promise<HTMLElement> {
  renderComponent(<ThemeProvider storageAdapter={memoryThemeStorage}>{ui}</ThemeProvider>);
  const trigger = await screen.findByRole('button', { name: /^Import into collection/ });
  if (mockImportServiceState.progress) {
    // The real service's first emission is what flips the flow's
    // showImportProgress latch; replay it here.
    await act(async () => {
      mockImportServiceState.emitProgress?.();
    });
  }
  return trigger;
}

async function openPicker(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(await renderAction(<ExplorerImportAction />));
  return await screen.findByTestId('explorer-import-picker');
}

/**
 * Opening a dialog dismisses the popover, so the previous picker node is
 * detached; re-open to assert against live DOM rather than a stale snapshot.
 */
async function reopenPicker(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /^Import into collection/ }));
  return await screen.findByTestId('explorer-import-picker');
}

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  mockUsePGliteDatabase.mockReset().mockReturnValue(mockDatabase);
  __resetImportActivitySnapshotForTests();
  mockCollectionsFetchError.current = null;
  __resetVectorStatusUIStoreForTests();
  __resetBackgroundIndexingPreferencesStoreForTests();
  __resetImportSettingsStoreForTests();
  mockImportFiles.mockClear();
  mockRefreshCollectionIndexingStats.mockClear();
  mockUseSelectionActionBarPin.mockClear();
  mockImportServiceState.emitProgress = null;
  mockImportServiceState.emitComplete = null;
  mockImportServiceState.isImporting = false;
  mockImportServiceState.progress = null;
  mockSelectedFilePaths.current = new Set(['root-1|@|/workspace/a.ts', 'root-1|@|/workspace/b.ts']);
  mockCollections.current = [
    collection({ id: 'docs' }),
    collection({ id: 'workspace-index', name: 'Workspace Index', systemRole: 'workspace-index' }),
  ];
  useVectorStatusUIStore.getState().setCachedCollections(mockCollections.current);
});

describe('ExplorerImportAction', () => {
  it('advertises the selection it would import', async () => {
    const trigger = await renderAction(<ExplorerImportAction />);

    expect(trigger).toHaveAccessibleName('Import into collection (2)');
  });

  it('mounts no picker until the action is opened', async () => {
    await renderAction(<ExplorerImportAction />);

    expect(screen.queryByTestId('explorer-import-picker')).not.toBeInTheDocument();
  });

  it('hides workspace-index collections from the import target list', async () => {
    const picker = await openPicker();

    const options = within(picker).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAttribute('aria-label', expect.stringContaining('Collection docs'));
  });

  it('blocks the import until a target collection is chosen', async () => {
    const picker = await openPicker();

    const confirm = within(picker).getByRole('button', {
      name: 'Import 2 files into the selected collection',
    });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('title', 'Select a collection first');
  });

  it('blocks imports into a background-indexed collection', async () => {
    act(() => {
      useVectorStatusUIStore.getState().setActiveEmbeddingSetId('docs');
      useBackgroundIndexingPreferencesStore.setState({ managedCollectionId: 'docs' });
    });

    const picker = await openPicker();

    const confirm = within(picker).getByRole('button', {
      name: 'Import 2 files into the selected collection',
    });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute(
      'title',
      'Background indexing manages imports for this collection'
    );
    expect(
      within(picker).getByText('Background indexing manages imports for this collection')
    ).toBeInTheDocument();
  });

  it('imports the explorer selection into the chosen collection', async () => {
    const user = userEvent.setup();
    const picker = await openPicker();

    await user.click(within(picker).getByRole('option', { name: /Collection docs/ }));

    await waitFor(() => {
      expect(useVectorStatusUIStore.getState().activeEmbeddingSetId).toBe('docs');
    });

    await user.click(
      within(picker).getByRole('button', { name: 'Import 2 files into the selected collection' })
    );

    await waitFor(() => {
      expect(mockImportFiles).toHaveBeenCalledTimes(1);
    });
    expect(mockImportFiles.mock.calls[0]?.[0]).toEqual(mockSelectedFilePaths.current);
  });

  it('refreshes the collection the run imported into, not whatever is active when it lands', async () => {
    // The picker — and its per-row Delete — sit one click behind a trigger that
    // stays enabled for the whole run, so the active collection can move out
    // from under an in-flight import. The service pins its own target at start;
    // completion has to describe the same run.
    const user = userEvent.setup();
    mockCollections.current = [collection({ id: 'docs' }), collection({ id: 'notes' })];
    const picker = await openPicker();

    await user.click(within(picker).getByRole('option', { name: /Collection docs/ }));
    await waitFor(() => {
      expect(useVectorStatusUIStore.getState().activeEmbeddingSetId).toBe('docs');
    });
    await user.click(
      within(picker).getByRole('button', { name: 'Import 2 files into the selected collection' })
    );

    // The user re-points the picker while the run is still going.
    act(() => {
      useVectorStatusUIStore.getState().setActiveEmbeddingSetId('notes');
    });

    await act(async () => {
      await mockImportServiceState.emitComplete?.([]);
    });

    expect(mockRefreshCollectionIndexingStats).toHaveBeenCalledTimes(1);
    expect(mockRefreshCollectionIndexingStats.mock.calls[0]?.[1]).toEqual(['docs']);
  });

  it('folds the post-import counts back into the shared cache', async () => {
    // The picker reads `cachedCollections` and only seeds it while it is empty,
    // so with no Database tab mounted — nobody owning the live query — nothing
    // else would ever replace the pre-import counts.
    const user = userEvent.setup();
    const picker = await openPicker();

    await user.click(within(picker).getByRole('option', { name: /Collection docs/ }));
    await waitFor(() => {
      expect(useVectorStatusUIStore.getState().activeEmbeddingSetId).toBe('docs');
    });
    await user.click(
      within(picker).getByRole('button', { name: 'Import 2 files into the selected collection' })
    );

    // The rollup refresh has landed, so the next snapshot reports the new counts.
    mockCollections.current = [collection({ chunkCount: 40, fileCount: 12, id: 'docs' })];

    await act(async () => {
      await mockImportServiceState.emitComplete?.([]);
    });

    const cached = useVectorStatusUIStore
      .getState()
      .cachedCollections.find((entry) => entry.id === 'docs');
    expect(cached?.fileCount).toBe(12);
    expect(cached?.chunkCount).toBe(40);
  });

  it('still refreshes the run target after the active collection is deleted', async () => {
    // Deleting the active collection sets the active id to null. Reading it at
    // completion would throw out of the service's onComplete instead of
    // refreshing the collection that actually gained files.
    const user = userEvent.setup();
    const picker = await openPicker();

    await user.click(within(picker).getByRole('option', { name: /Collection docs/ }));
    await waitFor(() => {
      expect(useVectorStatusUIStore.getState().activeEmbeddingSetId).toBe('docs');
    });
    await user.click(
      within(picker).getByRole('button', { name: 'Import 2 files into the selected collection' })
    );

    act(() => {
      useVectorStatusUIStore.getState().setActiveEmbeddingSetId(null);
    });

    await act(async () => {
      await mockImportServiceState.emitComplete?.([]);
    });

    expect(mockRefreshCollectionIndexingStats.mock.calls[0]?.[1]).toEqual(['docs']);
  });

  it('opens the create-collection dialog from the picker', async () => {
    const user = userEvent.setup();
    mockCollections.current = [];
    useVectorStatusUIStore.getState().setCachedCollections([]);
    const picker = await openPicker();

    await user.click(within(picker).getByRole('button', { name: 'Create First Collection' }));

    expect(await screen.findByTestId('mock-create-embedding-set-dialog')).toBeInTheDocument();
  });

  describe('while an import is running', () => {
    beforeEach(() => {
      mockImportServiceState.isImporting = true;
      mockImportServiceState.progress = {
        completed: 3,
        current: '/workspace/a.ts',
        errors: [],
        phase: 'importing',
        total: 8,
      };
    });

    it('shows the import progress panel', async () => {
      await renderAction(<ExplorerImportAction />);

      const progress = await screen.findByTestId('explorer-import-progress');
      expect(within(progress).getByText('Importing')).toBeInTheDocument();
      expect(within(progress).getByLabelText('Files import progress')).toBeInTheDocument();
      expect(within(progress).getByText('3/8')).toBeInTheDocument();
    });

    it('pins the selection bar so clearing the selection cannot tear the run down', async () => {
      await renderAction(<ExplorerImportAction />);

      // The service (and the app-wide embedding-queue-active flag it owns)
      // dies with this subtree, so the bar must be held open.
      expect(mockUseSelectionActionBarPin).toHaveBeenCalledWith(true);
    });

    it('publishes its progress for the app-wide import observability hook', async () => {
      await renderAction(<ExplorerImportAction />);

      expect(readImportActivitySnapshot()).toEqual({
        progress: expect.objectContaining({ completed: 3, phase: 'importing', total: 8 }),
        selectedFileCount: 2,
      });
    });

    it('keeps the progress panel and the pin after the selection empties', async () => {
      mockSelectedFilePaths.current = new Set();
      await renderAction(<ExplorerImportAction />);

      expect(await screen.findByTestId('explorer-import-progress')).toBeInTheDocument();
      expect(mockUseSelectionActionBarPin).toHaveBeenCalledWith(true);
    });

    it('releases the pin once a clean run finishes', async () => {
      // `showImportProgress` latches on the first progress event and is only
      // cleared by the card's Close button, so pinning on it alone would hold
      // the bar — and the tree padding it forces — open forever at zero
      // selection. A finished, error-free run needs no acknowledgement.
      mockImportServiceState.isImporting = false;
      mockImportServiceState.progress = {
        completed: 8,
        current: '',
        errors: [],
        phase: 'complete',
        total: 8,
      };

      await renderAction(<ExplorerImportAction />);

      expect(mockUseSelectionActionBarPin).toHaveBeenLastCalledWith(false);
    });

    it('releases the pin and offers a dismiss after a cancelled run', async () => {
      // The abort and failure paths return without emitting a final progress,
      // so `phase` stays mid-run and `completed < total` forever. Keying either
      // the pin or the Close button on "finished normally" stranded the bar
      // with no way to dismiss it.
      mockImportServiceState.isImporting = false;
      mockImportServiceState.progress = {
        completed: 3,
        current: '/workspace/a.ts',
        errors: [],
        phase: 'importing',
        total: 8,
      };

      await renderAction(<ExplorerImportAction />);

      expect(mockUseSelectionActionBarPin).toHaveBeenLastCalledWith(false);
      const progress = await screen.findByTestId('explorer-import-progress');
      expect(
        within(progress).getByRole('button', { name: 'Close import progress' })
      ).toBeInTheDocument();
    });

    it('holds the pin when a finished run reported errors', async () => {
      // Errors are the one thing the user has to actually read, so that run
      // keeps the bar until it is dismissed.
      mockImportServiceState.isImporting = false;
      mockImportServiceState.progress = {
        completed: 8,
        current: '',
        errors: [{ error: 'boom', file: '/workspace/b.ts' }],
        phase: 'complete',
        total: 8,
      };

      await renderAction(<ExplorerImportAction />);

      expect(mockUseSelectionActionBarPin).toHaveBeenLastCalledWith(true);
    });

    it('refuses to start a second import', async () => {
      act(() => {
        useVectorStatusUIStore.getState().setActiveEmbeddingSetId('docs');
      });
      const picker = await openPicker();

      const confirm = within(picker).getByRole('button', {
        name: 'Import 2 files into the selected collection',
      });
      expect(confirm).toBeDisabled();
      expect(confirm).toHaveAttribute('title', 'An import is already running');
    });
  });

  describe('keeping the shared collection cache honest', () => {
    // No Database tab is mounted in any of these: the explorer popover is the
    // only surface, so nothing else would repair the cache for it.
    it('drops a collection deleted from its own row', async () => {
      const user = userEvent.setup();
      const picker = await openPicker();

      await user.click(within(picker).getByRole('button', { name: 'Delete collection' }));
      await user.click(await screen.findByTestId('mock-delete-embedding-set-dialog'));

      await waitFor(() => {
        expect(
          useVectorStatusUIStore.getState().cachedCollections.some(({ id }) => id === 'docs')
        ).toBe(false);
      });
      const reopened = await reopenPicker();
      expect(within(reopened).queryByRole('option', { name: /Collection docs/ })).toBeNull();
    });

    it('shows the new name after a rename from its own row', async () => {
      const user = userEvent.setup();
      const picker = await openPicker();

      await user.click(within(picker).getByRole('button', { name: 'Edit collection' }));
      await user.click(await screen.findByTestId('mock-rename-embedding-set-dialog'));

      const reopened = await reopenPicker();
      expect(
        await within(reopened).findByRole('option', { name: /Renamed Collection/ })
      ).toBeInTheDocument();
      expect(within(reopened).queryByRole('option', { name: /Collection docs/ })).toBeNull();
    });
  });

  it('surfaces a failed collections query instead of an empty picker', async () => {
    // An empty list here would read as "no collections exist" and invite the
    // user to create a duplicate.
    mockCollections.current = [];
    useVectorStatusUIStore.getState().setCachedCollections([]);
    mockCollectionsFetchError.current = new Error('relation "embedding_sets" does not exist');

    const picker = await openPicker();

    const alert = await within(picker).findByTestId('explorer-import-picker-error');
    expect(alert).toHaveTextContent("Couldn't load collections");
    expect(alert).toHaveTextContent('relation "embedding_sets" does not exist');
    expect(
      within(picker).queryByRole('button', { name: 'Create First Collection' })
    ).not.toBeInTheDocument();
  });

  it('leaves the selection bar unpinned while idle', async () => {
    await renderAction(<ExplorerImportAction />);

    expect(mockUseSelectionActionBarPin).toHaveBeenCalledWith(false);
    expect(mockUseSelectionActionBarPin).not.toHaveBeenCalledWith(true);
  });

  it('pins the bar while a collection dialog is open', async () => {
    // The dialogs live in this subtree, which dies with the selection — and the
    // selection can drop to zero without a click (root change, refresh,
    // watcher-driven pruning), taking a half-filled Create dialog with it.
    const user = userEvent.setup();
    mockCollections.current = [];
    useVectorStatusUIStore.getState().setCachedCollections([]);
    const picker = await openPicker();
    mockUseSelectionActionBarPin.mockClear();

    await user.click(within(picker).getByRole('button', { name: 'Create First Collection' }));

    expect(await screen.findByTestId('mock-create-embedding-set-dialog')).toBeInTheDocument();
    expect(mockUseSelectionActionBarPin).toHaveBeenLastCalledWith(true);
  });

  it('activates a freshly created collection as the import target', async () => {
    const user = userEvent.setup();
    mockCollections.current = [];
    useVectorStatusUIStore.getState().setCachedCollections([]);
    const picker = await openPicker();

    await user.click(within(picker).getByRole('button', { name: 'Create' }));
    await user.click(await screen.findByTestId('mock-create-embedding-set-dialog'));

    await waitFor(() => {
      expect(useVectorStatusUIStore.getState().activeEmbeddingSetId).toBe('created-set-id');
    });
  });
});

it('refreshes the native collection projection after import without acquiring or refreshing SQL', async () => {
  vi.stubGlobal('sourceFiles', { import: vi.fn() });
  mockUsePGliteDatabase.mockImplementation((options) => {
    if (options?.enabled !== false) {
      throw new Error('Desktop must not initialize PG');
    }
    return null;
  });
  const user = userEvent.setup();
  const picker = await openPicker();
  await user.click(within(picker).getByRole('option', { name: /Collection docs/ }));
  await user.click(
    within(picker).getByRole('button', { name: 'Import 2 files into the selected collection' })
  );
  mockCollections.current = [collection({ chunkCount: 12, fileCount: 4, id: 'docs' })];
  await act(async () => {
    await mockImportServiceState.emitComplete?.([]);
  });
  expect(mockRefreshCollectionIndexingStats).not.toHaveBeenCalled();
  expect(useVectorStatusUIStore.getState().cachedCollections).toEqual(mockCollections.current);
});
