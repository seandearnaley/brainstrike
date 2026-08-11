import { createTestActionRegistry } from '@brainstrike/context-actions';
import { ActionRegistryProvider, type SemanticSearchResult } from '@brainstrike/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  {
    chunksCount: 300,
    chunksProcessedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    embeddedChunksCount: 300,
    id: 'file-3',
    name: 'gamma.md',
    path: 'docs/gamma.md',
    size: 90_000,
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

/** Chunk pages requested during a test, derived from the query's OFFSET param. */
let chunkQueryPages: number[] = [];

function chunkPageRows(page: number) {
  return Array.from({ length: 50 }, (_, i) => {
    const index = page * 50 + i;
    return {
      chunkIndex: index,
      content: `chunk body ${index}`,
      embeddingDimensions: 768,
      failed: false,
      hasEmbedding: true,
      id: `big-chunk-${index}`,
      tokenCount: 4,
    };
  });
}

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
    query: vi.fn((sql: string, params?: readonly unknown[]) => {
      if (sql.includes('scoped_files')) {
        return Promise.resolve({ rows: INCOMPLETE_ROWS });
      }
      if (sql.includes('WHERE fc.file_record_id = $1')) {
        const [fileRecordId, , limit, offset] = (params ?? []) as [string, string, number, number];
        const page = Math.floor(Number(offset) / Number(limit));
        chunkQueryPages.push(page);
        if (fileRecordId === 'file-3') {
          return Promise.resolve({ rows: chunkPageRows(page) });
        }
        return Promise.resolve({ rows: CHUNK_ROWS });
      }
      throw new Error(`Unexpected query: ${sql.slice(0, 60)}`);
    }),
  };
}

function renderContent(overrides: { systemRole?: 'workspace-index' | null } = {}): {
  onRecordPageChange: ReturnType<typeof vi.fn<(page: number) => void>>;
  rerenderWithCollection: (collectionId: string | null) => void;
  rerenderWithRecords: (next: DatabaseFileRecordSummary[]) => void;
  writtenTexts: string[];
} {
  const { registry, writtenTexts } = createTestActionRegistry({ actions: collectionActions });
  const database = makeDatabase();
  const onRecordPageChange = vi.fn<(page: number) => void>();
  const tree = (records: DatabaseFileRecordSummary[], collectionId: string | null = 'col-1') => (
    <ActionRegistryProvider registry={registry}>
      <CollectionDebugDrawerContent
        activeCollectionId={collectionId}
        activeCollectionSystemRole={overrides.systemRole ?? null}
        chunkRepository={null}
        database={database}
        fileRepository={null}
        onRecordPageChange={onRecordPageChange}
        recordPagination={{ currentPage: 0, pageSize: 50, totalPages: 2, totalRecords: 4 }}
        records={records}
      />
    </ActionRegistryProvider>
  );
  const { rerender } = render(tree(RECORDS));
  return {
    onRecordPageChange,
    rerenderWithCollection: (collectionId) => rerender(tree(RECORDS, collectionId)),
    rerenderWithRecords: (next) => rerender(tree(next)),
    writtenTexts,
  };
}

/**
 * Renders with the incomplete-files query left permanently pending, so the
 * failed-embeddings section is genuinely mid-load.
 */
function renderContentWithPendingFailedList(): {
  rerenderWithCollection: (collectionId: string | null) => void;
} {
  const { registry } = createTestActionRegistry({ actions: collectionActions });
  const database = {
    query: vi.fn((sql: string) => {
      if (sql.includes('scoped_files')) {
        return new Promise(() => undefined);
      }
      return Promise.resolve({ rows: CHUNK_ROWS });
    }),
  };
  const tree = (collectionId: string | null) => (
    <ActionRegistryProvider registry={registry}>
      <CollectionDebugDrawerContent
        activeCollectionId={collectionId}
        activeCollectionSystemRole={null}
        chunkRepository={null}
        database={database}
        fileRepository={null}
        onRecordPageChange={vi.fn()}
        recordPagination={{ currentPage: 0, pageSize: 50, totalPages: 2, totalRecords: 4 }}
        records={RECORDS}
      />
    </ActionRegistryProvider>
  );
  const { rerender } = render(tree('col-1'));
  return { rerenderWithCollection: (collectionId) => rerender(tree(collectionId)) };
}

/** A second Files page: none of the round-0 file ids appear here. */
const SECOND_PAGE_RECORDS: DatabaseFileRecordSummary[] = [
  {
    chunksCount: 1,
    chunksProcessedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    embeddedChunksCount: 1,
    id: 'file-9',
    name: 'omega.md',
    path: 'docs/omega.md',
    size: 10,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

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
    chunkQueryPages = [];
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
            onRecordPageChange={vi.fn()}
            recordPagination={{ currentPage: 0, pageSize: 50, totalPages: 1, totalRecords: 3 }}
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

  describe('chunk pagination', () => {
    it('states the visible chunk range and pages a file larger than one chunk page', async () => {
      const user = userEvent.setup();
      renderContent();

      await user.click(screen.getByRole('button', { name: /gamma\.md/ }));
      await screen.findByTestId('collection-debug-chunk-list');

      // 300 chunks cannot fit one 50-row page: say so rather than showing 50
      // rows that look like the whole file.
      expect(screen.getByTestId('collection-debug-chunk-range')).toHaveTextContent(
        /1[–-]50 of 300/
      );

      await user.click(screen.getByRole('button', { name: /next chunk page/i }));

      await waitFor(() => {
        expect(screen.getByTestId('collection-debug-chunk-range')).toHaveTextContent(
          /51[–-]100 of 300/
        );
      });
      // Page 1 must actually be requested with the right offset.
      expect(chunkQueryPages).toContain(1);
    });
  });

  describe('paging the Files pane while a file is selected', () => {
    it('routes page changes through the panel-owned pagination callback', async () => {
      const user = userEvent.setup();
      const { onRecordPageChange } = renderContent();

      await user.click(screen.getByRole('button', { name: /next file page/i }));

      expect(onRecordPageChange).toHaveBeenCalledOnce();
      expect(onRecordPageChange).toHaveBeenCalledWith(1);
    });

    it('drops the previous file’s chunks instead of leaving them rendered', async () => {
      const user = userEvent.setup();
      const { rerenderWithRecords } = renderContent();

      await user.click(screen.getByRole('button', { name: /alpha\.md/ }));
      const chunkList = await screen.findByTestId('collection-debug-chunk-list');
      expect(within(chunkList).getByText(/quick brown fox/)).toBeInTheDocument();

      // The Files pager moves recordPage, which swaps `records` for a page that
      // no longer contains the selected file.
      rerenderWithRecords(SECOND_PAGE_RECORDS);

      await waitFor(() => {
        expect(screen.queryByText(/quick brown fox/)).not.toBeInTheDocument();
      });
      // ...and the range readout must not survive as "1–50 of 0".
      expect(screen.queryByTestId('collection-debug-chunk-range')).not.toBeInTheDocument();
      expect(screen.getByTestId('collection-debug-inspector')).toHaveTextContent(
        /select a file to list its chunks/i
      );
    });

    it('keeps the selection when the same file is still on the new page', async () => {
      const user = userEvent.setup();
      const { rerenderWithRecords } = renderContent();

      await user.click(screen.getByRole('button', { name: /alpha\.md/ }));
      await screen.findByTestId('collection-debug-chunk-list');

      // A live-query refresh that still contains the selected file must not
      // clear it — only a genuine disappearance should.
      rerenderWithRecords([...RECORDS]);

      expect(screen.getByText(/quick brown fox/)).toBeInTheDocument();
    });
  });

  describe('row semantics', () => {
    it('honors keyboard activation on a failed-list row by opening its menu', async () => {
      const user = userEvent.setup();
      const { writtenTexts } = renderContent();
      const list = await screen.findByTestId('collection-debug-failed-list');

      // These rows are buttons whose only affordance is the context menu, so
      // Enter must actually do something rather than silently no-op.
      within(list)
        .getByRole('button', { name: /beta\.md/ })
        .focus();
      await user.keyboard('{Enter}');

      const menu = await screen.findByRole('menu');
      await user.click(within(menu).getByRole('menuitem', { name: 'Copy Path' }));

      await waitFor(() => {
        expect(writtenTexts).toContain('docs/beta.md');
      });
    });

    it('honors keyboard activation on a retrieval result row by opening its menu', async () => {
      const user = userEvent.setup();
      executeSearch.mockResolvedValue([
        {
          chunkId: 'chunk-1',
          content: 'the quick brown fox',
          fileName: 'alpha.md',
          filePath: 'docs/alpha.md',
          fileRecordId: 'file-1',
          nodeId: 'chunk-chunk-1',
          similarity: 0.5,
        },
      ]);
      const { writtenTexts } = renderContent();

      await user.type(screen.getByLabelText('Retrieval preview query'), 'fox');
      await user.click(screen.getByRole('button', { name: /^Run$/ }));

      const results = await screen.findByTestId('collection-debug-retrieval-results');
      within(results)
        .getByRole('button', { name: /quick brown fox/ })
        .focus();
      await user.keyboard('{Enter}');

      const menu = await screen.findByRole('menu');
      await user.click(within(menu).getByRole('menuitem', { name: 'Copy Content' }));

      await waitFor(() => {
        expect(writtenTexts).toContain('the quick brown fox');
      });
    });
  });

  describe('collection switching (PR #2381 review)', () => {
    const RESULT = {
      chunkId: 'chunk-1',
      content: 'the quick brown fox',
      fileName: 'alpha.md',
      filePath: 'docs/alpha.md',
      fileRecordId: 'file-1',
      nodeId: 'chunk-chunk-1',
      similarity: 0.8,
    };

    it('drops retrieval results when the active collection changes', async () => {
      const user = userEvent.setup();
      executeSearch.mockResolvedValue([RESULT]);
      const { rerenderWithCollection } = renderContent();

      await user.type(screen.getByLabelText('Retrieval preview query'), 'fox');
      await user.click(screen.getByRole('button', { name: /^Run$/ }));
      expect(await screen.findByTestId('collection-debug-retrieval-results')).toBeInTheDocument();

      rerenderWithCollection('col-2');

      // Stale scored chunks must not render under the new collection's
      // heading — each row also claims a `chunk` context target, so Copy ID /
      // Copy Content would otherwise hand out the OLD collection's chunk.
      await waitFor(() => {
        expect(screen.queryByTestId('collection-debug-retrieval-results')).not.toBeInTheDocument();
      });
    });

    it('discards a run that was still in flight when the collection changed', async () => {
      const user = userEvent.setup();
      let settle: (value: (typeof RESULT)[]) => void = () => undefined;
      executeSearch.mockImplementation(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          })
      );
      const { rerenderWithCollection } = renderContent();

      await user.type(screen.getByLabelText('Retrieval preview query'), 'fox');
      await user.click(screen.getByRole('button', { name: /^Run$/ }));

      rerenderWithCollection('col-2');
      // The old collection's run lands AFTER the switch.
      await act(async () => {
        settle([RESULT]);
        await Promise.resolve();
      });

      expect(screen.queryByTestId('collection-debug-retrieval-results')).not.toBeInTheDocument();
    });

    it('leaves no stuck loading state when the collection drops to null mid-load', async () => {
      // The incomplete-files read must still be PENDING when the collection
      // goes null: its own isCurrent() guard then suppresses the response, so
      // nothing else would ever clear `loading` and "Loading…" latched in place
      // of the no-selection message.
      const { rerenderWithCollection } = renderContentWithPendingFailedList();

      expect(screen.getByTestId('collection-debug-failed')).toHaveTextContent(/Loading…/);

      rerenderWithCollection(null);

      await waitFor(() => {
        expect(screen.getByTestId('collection-debug-failed')).toHaveTextContent(
          /select a collection to list files that need attention/i
        );
      });
      expect(screen.getByTestId('collection-debug-failed')).not.toHaveTextContent(/Loading…/);
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
            onRecordPageChange={vi.fn()}
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
