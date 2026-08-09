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
import { act, render as renderComponent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExplorerImportAction } from '../components/explorer-import-action';

const {
  mockCollections,
  mockDatabase,
  mockImportFiles,
  mockRefreshCollectionIndexingStats,
  mockSelectedFilePaths,
} = vi.hoisted(() => ({
  mockCollections: { current: [] as CollectionPickerCollection[] },
  mockDatabase: { query: vi.fn() },
  mockImportFiles: vi.fn().mockResolvedValue(undefined),
  mockRefreshCollectionIndexingStats: vi.fn().mockResolvedValue(undefined),
  mockSelectedFilePaths: { current: new Set<string>() },
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
    usePGliteDatabase: () => mockDatabase,
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
    DeleteEmbeddingSetDialog: () => <div data-testid="mock-delete-embedding-set-dialog" />,
    RenameEmbeddingSetDialog: () => <div data-testid="mock-rename-embedding-set-dialog" />,
    useCollections: () => ({
      collections: mockCollections.current,
      error: null,
      loading: false,
    }),
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
  useEnhancedFileImportService: () => ({
    cancelImport: vi.fn(),
    chunkRepository: null,
    importFiles: mockImportFiles,
    isImporting: false,
    progress: null,
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorer: () => ({
    fileContents: {},
    fileTree: [],
    unfilteredFileTree: null,
  }),
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
  return await screen.findByRole('button', { name: /^Import into collection/ });
}

async function openPicker(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(await renderAction(<ExplorerImportAction />));
  return await screen.findByTestId('explorer-import-picker');
}

beforeEach(() => {
  __resetVectorStatusUIStoreForTests();
  __resetBackgroundIndexingPreferencesStoreForTests();
  __resetImportSettingsStoreForTests();
  mockImportFiles.mockClear();
  mockRefreshCollectionIndexingStats.mockClear();
  mockSelectedFilePaths.current = new Set(['root-1|@|/workspace/a.ts', 'root-1|@|/workspace/b.ts']);
  mockCollections.current = [
    collection({ id: 'docs' }),
    collection({ id: 'workspace-index', name: 'Workspace Index', systemRole: 'workspace-index' }),
  ];
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
      name: 'Import selected files into collection',
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
      name: 'Import selected files into collection',
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
      within(picker).getByRole('button', { name: 'Import selected files into collection' })
    );

    await waitFor(() => {
      expect(mockImportFiles).toHaveBeenCalledTimes(1);
    });
    expect(mockImportFiles.mock.calls[0]?.[0]).toEqual(mockSelectedFilePaths.current);
  });

  it('opens the create-collection dialog from the picker', async () => {
    const user = userEvent.setup();
    mockCollections.current = [];
    const picker = await openPicker();

    await user.click(within(picker).getByRole('button', { name: 'Create First Collection' }));

    expect(await screen.findByTestId('mock-create-embedding-set-dialog')).toBeInTheDocument();
  });

  it('activates a freshly created collection as the import target', async () => {
    const user = userEvent.setup();
    mockCollections.current = [];
    const picker = await openPicker();

    await user.click(within(picker).getByRole('button', { name: 'Create' }));
    await user.click(await screen.findByTestId('mock-create-embedding-set-dialog'));

    await waitFor(() => {
      expect(useVectorStatusUIStore.getState().activeEmbeddingSetId).toBe('created-set-id');
    });
  });
});
