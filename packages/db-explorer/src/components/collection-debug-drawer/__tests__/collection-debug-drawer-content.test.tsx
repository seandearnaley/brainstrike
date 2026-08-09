import { createTestActionRegistry } from '@brainstrike/context-actions';
import { ActionRegistryProvider, type SemanticSearchResult } from '@brainstrike/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectionActions } from '../../../context-actions/collection-actions';
import { __resetDatabaseDemoStoreForTests } from '../../../stores/database-demo-store';
import type { DatabaseFileRecordSummary } from '../../../use-database-demo-data';

const executeSearch = vi.fn<(...args: unknown[]) => Promise<SemanticSearchResult[]>>();
let executorAvailable = true;

vi.mock('../../../hooks/use-collection-embedding-coverage', () => ({
  useCollectionEmbeddingCoverage: () => ({
    error: null,
    loading: false,
    snapshot: {
      chunksMissingSourceRange: 0,
      pendingReindexFileCount: 1,
      status: 'needs_reindex' as const,
      totalChunks: 6,
      totalFiles: 2,
    },
  }),
}));

vi.mock('../../../hooks/use-semantic-search-executor', () => ({
  useSemanticSearchExecutor: () => (executorAvailable ? executeSearch : undefined),
}));

const { default: CollectionDebugDrawerContent } = await import(
  '../collection-debug-drawer-content'
);

const RECORDS: DatabaseFileRecordSummary[] = [
  {
    chunksCount: 2,
    chunksProcessedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    embeddedChunksCount: 2,
    id: 'file-1',
    name: 'alpha.md',
    path: 'docs/alpha.md',
    size: 120,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    chunksCount: 4,
    chunksProcessedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    embeddedChunksCount: 1,
    id: 'file-2',
    name: 'beta.md',
    path: 'docs/beta.md',
    size: 400,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const CHUNK_ROWS = [
  {
    chunkIndex: 0,
    content: 'the quick brown fox',
    embeddingDimensions: 768,
    failed: false,
    hasEmbedding: true,
    id: 'chunk-1',
    tokenCount: 5,
  },
  {
    chunkIndex: 1,
    content: 'jumps over the lazy dog',
    embeddingDimensions: 0,
    failed: true,
    hasEmbedding: false,
    id: 'chunk-2',
    tokenCount: 6,
  },
];

const INCOMPLETE_ROWS = [
  {
    chunksCount: 4,
    chunksProcessed: true,
    embeddedChunksCount: 1,
    failedChunksCount: 2,
    id: 'file-2',
    name: 'beta.md',
    path: 'docs/beta.md',
  },
];

function makeDatabase() {
  return {
    // `scoped_files` is unique to the incomplete-files query; the chunk query
    // is the one that filters on a single file_record_id. Both mention
    // `FROM file_chunks fc`, so discriminate on the narrower marker first.
    query: vi.fn((sql: string) => {
      if (sql.includes('scoped_files')) {
        return Promise.resolve({ rows: INCOMPLETE_ROWS });
      }
      if (sql.includes('WHERE fc.file_record_id = $1')) {
        return Promise.resolve({ rows: CHUNK_ROWS });
      }
      throw new Error(`Unexpected query: ${sql.slice(0, 60)}`);
    }),
  };
}

function renderContent(overrides: { systemRole?: 'workspace-index' | null } = {}): {
  writtenTexts: string[];
} {
  const { registry, writtenTexts } = createTestActionRegistry({ actions: collectionActions });
  render(
    <ActionRegistryProvider registry={registry}>
      <CollectionDebugDrawerContent
        activeCollectionId="col-1"
        activeCollectionSystemRole={overrides.systemRole ?? null}
        chunkRepository={null}
        database={makeDatabase()}
        fileRepository={null}
        recordPagination={{ currentPage: 0, pageSize: 50, totalPages: 1, totalRecords: 2 }}
        records={RECORDS}
      />
    </ActionRegistryProvider>
  );
  return { writtenTexts };
}

async function closeMenuAndFlushFocusRestore(): Promise<void> {
  if (screen.queryByRole('menu')) {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('collection debug drawer content', () => {
  beforeEach(() => {
    __resetDatabaseDemoStoreForTests();
    executeSearch.mockReset();
    executorAvailable = true;
  });

  afterEach(async () => {
    await closeMenuAndFlushFocusRestore();
    __resetDatabaseDemoStoreForTests();
  });

  describe('chunk/embedding inspector', () => {
    it('lists the collection files with their derived embedding status', () => {
      renderContent();
      const list = screen.getByTestId('collection-debug-file-list');
      expect(within(list).getByText('alpha.md')).toBeInTheDocument();
      // 2/2 embedded => complete; 1/4 => still processing.
      expect(within(list).getByText('2/2')).toBeInTheDocument();
      expect(within(list).getByText('1/4')).toBeInTheDocument();
    });

    it('loads chunks on demand for the selected file and inspects the chosen chunk', async () => {
      const user = userEvent.setup();
      renderContent();

      await user.click(screen.getByRole('button', { name: /alpha\.md/ }));

      const chunkList = await screen.findByTestId('collection-debug-chunk-list');
      expect(within(chunkList).getByText('#0')).toBeInTheDocument();
      expect(within(chunkList).getByText('768d')).toBeInTheDocument();

      await user.click(within(chunkList).getByRole('button', { name: /quick brown fox/ }));

      const inspector = screen.getByTestId('collection-debug-node-inspector');
      expect(within(inspector).getByText('the quick brown fox')).toBeInTheDocument();
      expect(within(inspector).getByText('chunk-1')).toBeInTheDocument();
    });

    it('surfaces a chunk-load failure instead of rendering an empty chunk list', async () => {
      const user = userEvent.setup();
      const { registry } = createTestActionRegistry({ actions: collectionActions });
      render(
        <ActionRegistryProvider registry={registry}>
          <CollectionDebugDrawerContent
            activeCollectionId="col-1"
            activeCollectionSystemRole={null}
            chunkRepository={null}
            database={{ query: () => Promise.reject(new Error('pglite exploded')) }}
            fileRepository={null}
            recordPagination={{ currentPage: 0, pageSize: 50, totalPages: 1, totalRecords: 2 }}
            records={RECORDS}
          />
        </ActionRegistryProvider>
      );

      await user.click(screen.getByRole('button', { name: /alpha\.md/ }));

      expect(await screen.findByTestId('collection-debug-chunks-error')).toHaveTextContent(
        /pglite exploded/
      );
    });
  });

  describe('retrieval preview', () => {
    it('runs a scored one-shot search and renders each score with a text equivalent', async () => {
      const user = userEvent.setup();
      executeSearch.mockResolvedValue([
        {
          chunkId: 'chunk-1',
          content: 'the quick brown fox',
          fileName: 'alpha.md',
          filePath: 'docs/alpha.md',
          fileRecordId: 'file-1',
          nodeId: 'chunk-chunk-1',
          similarity: 0.8123,
        },
      ]);
      renderContent();

      await user.type(screen.getByLabelText('Retrieval preview query'), 'fox');
      await user.click(screen.getByRole('button', { name: /^Run$/ }));

      const results = await screen.findByTestId('collection-debug-retrieval-results');
      expect(within(results).getByText('81.23%')).toBeInTheDocument();
      expect(within(results).getByText('Score 81.23 percent (0.8123)')).toBeInTheDocument();
      expect(executeSearch).toHaveBeenCalledWith('fox', expect.anything(), 'col-1');
    });

    it('refuses a system-managed workspace-index collection with a visible reason', () => {
      renderContent({ systemRole: 'workspace-index' });

      const refusal = screen.getByTestId('collection-debug-retrieval-refusal');
      expect(refusal).toHaveTextContent(/system-managed/i);
      expect(screen.getByLabelText('Retrieval preview query')).toBeDisabled();
      expect(screen.getByRole('button', { name: /^Run$/ })).toBeDisabled();
    });

    it('states why retrieval is unavailable when the executor cannot be built', () => {
      executorAvailable = false;
      renderContent();

      expect(screen.getByTestId('collection-debug-retrieval-refusal')).toHaveTextContent(
        /repositories are not available/i
      );
    });

    it('surfaces a failed search rather than silently showing no results', async () => {
      const user = userEvent.setup();
      executeSearch.mockRejectedValue(new Error('embedder unavailable'));
      renderContent();

      await user.type(screen.getByLabelText('Retrieval preview query'), 'fox');
      await user.click(screen.getByRole('button', { name: /^Run$/ }));

      expect(await screen.findByTestId('collection-debug-retrieval-error')).toHaveTextContent(
        /embedder unavailable/
      );
    });
  });

  describe('not-fully-embedded list', () => {
    it('lists files the collection has not finished embedding, labelled failed when the queue failed', async () => {
      renderContent();

      const list = await screen.findByTestId('collection-debug-failed-list');
      expect(within(list).getByText('beta.md')).toBeInTheDocument();
      expect(within(list).getByText('Failed')).toBeInTheDocument();
      expect(within(list).getByText('1/4')).toBeInTheDocument();
    });
  });

  describe('with no active collection', () => {
    function renderWithoutCollection() {
      const { registry } = createTestActionRegistry({ actions: collectionActions });
      render(
        <ActionRegistryProvider registry={registry}>
          <CollectionDebugDrawerContent
            activeCollectionId={null}
            activeCollectionSystemRole={null}
            chunkRepository={null}
            database={makeDatabase()}
            fileRepository={null}
            recordPagination={{ currentPage: 0, pageSize: 50, totalPages: 0, totalRecords: 0 }}
            records={[]}
          />
        </ActionRegistryProvider>
      );
    }

    it('does not claim the collection is fully embedded when there is no collection', () => {
      renderWithoutCollection();

      const section = screen.getByTestId('collection-debug-failed');
      // The "Not fully embedded" heading is expected; the false all-clear is not.
      expect(section).not.toHaveTextContent(/Every file in this collection is fully embedded/i);
      expect(section).toHaveTextContent(/select a collection/i);
    });

    it('asks for a collection instead of reporting an empty file page', () => {
      renderWithoutCollection();

      expect(screen.getByTestId('collection-debug-inspector')).toHaveTextContent(
        /select a collection/i
      );
    });
  });

  describe('chunk context actions', () => {
    it('copies chunk content from a chunk row', async () => {
      const user = userEvent.setup();
      const { writtenTexts } = renderContent();

      await user.click(screen.getByRole('button', { name: /alpha\.md/ }));
      const chunkList = await screen.findByTestId('collection-debug-chunk-list');

      fireEvent.contextMenu(within(chunkList).getByRole('button', { name: /quick brown fox/ }), {
        clientX: 10,
        clientY: 10,
      });

      const menu = await screen.findByRole('menu');
      await user.click(within(menu).getByRole('menuitem', { name: 'Copy Content' }));

      await waitFor(() => {
        expect(writtenTexts).toContain('the quick brown fox');
      });
    });

    it('copies the chunk id from a chunk row', async () => {
      const user = userEvent.setup();
      const { writtenTexts } = renderContent();

      await user.click(screen.getByRole('button', { name: /alpha\.md/ }));
      const chunkList = await screen.findByTestId('collection-debug-chunk-list');

      fireEvent.contextMenu(within(chunkList).getByRole('button', { name: /quick brown fox/ }), {
        clientX: 10,
        clientY: 10,
      });

      const menu = await screen.findByRole('menu');
      await user.click(within(menu).getByRole('menuitem', { name: 'Copy ID' }));

      await waitFor(() => {
        expect(writtenTexts).toContain('chunk-1');
      });
    });

    it('offers the file copy actions on a file row', async () => {
      const { writtenTexts } = renderContent();

      fireEvent.contextMenu(screen.getByRole('button', { name: /alpha\.md/ }), {
        clientX: 10,
        clientY: 10,
      });

      const menu = await screen.findByRole('menu');
      expect(within(menu).getByRole('menuitem', { name: 'Copy Name' })).toBeInTheDocument();
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy Path' }));

      await waitFor(() => {
        expect(writtenTexts).toContain('docs/alpha.md');
      });
    });
  });
});
