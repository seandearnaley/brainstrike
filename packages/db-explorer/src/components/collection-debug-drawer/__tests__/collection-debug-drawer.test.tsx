import { createTestActionRegistry } from '@brainstrike/context-actions';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectionActions } from '../../../context-actions/collection-actions';
import { __resetDatabaseDemoStoreForTests } from '../../../stores/database-demo-store';
import type { DatabaseFileRecordSummary } from '../../../use-database-demo-data';

const coverageHookCalls = vi.fn();
const executorHookCalls = vi.fn();

vi.mock('../../../hooks/use-collection-embedding-coverage', () => ({
  useCollectionEmbeddingCoverage: (id: string | null) => {
    coverageHookCalls(id);
    return {
      error: null,
      loading: false,
      snapshot: {
        chunksMissingSourceRange: 0,
        pendingReindexFileCount: 0,
        status: 'fully_indexed' as const,
        totalChunks: 8,
        totalFiles: 2,
      },
    };
  },
}));

vi.mock('../../../hooks/use-semantic-search-executor', () => ({
  useSemanticSearchExecutor: () => {
    executorHookCalls();
    return vi.fn();
  },
}));

const { CollectionDebugDrawer } = await import('../collection-debug-drawer');
// Warm the lazily-imported content module. Without this the zero-cost-closed
// assertion below could pass merely because the dynamic import had not
// resolved yet, rather than because the drawer refused to mount it.
await import('../collection-debug-drawer-content');

const RECORDS: DatabaseFileRecordSummary[] = [
  {
    chunksCount: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
    embeddedChunksCount: 4,
    id: 'file-1',
    name: 'alpha.md',
    path: 'docs/alpha.md',
    size: 120,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

function makeDatabase(): { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) };
}

function renderDrawer(database: { query: ReturnType<typeof vi.fn> }) {
  const { registry } = createTestActionRegistry({ actions: collectionActions });
  return render(
    <ActionRegistryProvider registry={registry}>
      <CollectionDebugDrawer
        activeCollectionId="col-1"
        activeCollectionSystemRole={null}
        chunkRepository={null}
        database={database}
        fileRepository={null}
        onRecordPageChange={vi.fn()}
        recordPagination={{ currentPage: 0, pageSize: 50, totalPages: 1, totalRecords: 1 }}
        records={RECORDS}
      />
    </ActionRegistryProvider>
  );
}

describe('CollectionDebugDrawer disclosure', () => {
  beforeEach(() => {
    __resetDatabaseDemoStoreForTests();
    coverageHookCalls.mockClear();
    executorHookCalls.mockClear();
  });

  afterEach(() => {
    __resetDatabaseDemoStoreForTests();
  });

  it('renders collapsed by default as a real disclosure button', () => {
    renderDrawer(makeDatabase());

    const toggle = screen.getByRole('button', { name: /collection details/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls');
    expect(screen.queryByTestId('collection-debug-drawer-content')).not.toBeInTheDocument();
  });

  it('performs no queries and mounts no data hooks while collapsed', async () => {
    const database = makeDatabase();
    renderDrawer(database);

    // The content module is already in the module cache (warmed above), so an
    // eagerly-mounted drawer would have rendered and issued its reads well
    // inside this window.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(screen.queryByTestId('collection-debug-drawer-content')).not.toBeInTheDocument();
    expect(database.query).not.toHaveBeenCalled();
    expect(coverageHookCalls).not.toHaveBeenCalled();
    expect(executorHookCalls).not.toHaveBeenCalled();
  });

  it('mounts the content and starts querying only once opened', async () => {
    const user = userEvent.setup();
    const database = makeDatabase();
    renderDrawer(database);

    await user.click(screen.getByRole('button', { name: /collection details/i }));

    expect(await screen.findByTestId('collection-debug-drawer-content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /collection details/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await waitFor(() => {
      expect(coverageHookCalls).toHaveBeenCalledWith('col-1');
    });
    await waitFor(() => {
      expect(database.query).toHaveBeenCalled();
    });
  });

  it('unmounts the content again when collapsed, releasing its subscriptions', async () => {
    const user = userEvent.setup();
    const database = makeDatabase();
    renderDrawer(database);

    const toggle = screen.getByRole('button', { name: /collection details/i });
    await user.click(toggle);
    expect(await screen.findByTestId('collection-debug-drawer-content')).toBeInTheDocument();

    await user.click(toggle);
    await waitFor(() => {
      expect(screen.queryByTestId('collection-debug-drawer-content')).not.toBeInTheDocument();
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
