import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceSearchStore } from '../../core/workspace-search-store';
import type { CollectionStatsRow } from '../collection-stats-query';
import { SearchCollectionPicker } from '../search-collection-picker';

const { usePGliteLiveQueryMock } = vi.hoisted(() => ({
  usePGliteLiveQueryMock: vi.fn((): { rows: CollectionStatsRow[] } => ({ rows: [] })),
}));

vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: (...args: unknown[]) => JSON.stringify(args),
  usePGliteLiveQuery: usePGliteLiveQueryMock,
}));

const managedRow: CollectionStatsRow = {
  chunkCount: 4,
  embeddedChunkCount: 4,
  fileCount: 2,
  id: 'workspace-index',
  name: 'Workspace Index',
  pendingChunkCount: 0,
  systemRole: 'workspace-index',
};

describe('SearchCollectionPicker readiness', () => {
  beforeEach(() => {
    usePGliteLiveQueryMock.mockReturnValue({ rows: [] });
    useWorkspaceSearchStore.getState().reset();
  });

  it('does not mark pending rows ready even when identical text exists elsewhere', () => {
    render(
      <>
        <h2>Workspace Index</h2>
        <SearchCollectionPicker />
      </>
    );

    expect(screen.getAllByText('Workspace Index')).toHaveLength(2);
    expect(screen.queryByTestId('workspace-search-single-collection')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('marks only the resolved quiet label when other text has the same name', () => {
    usePGliteLiveQueryMock.mockReturnValue({ rows: [managedRow] });
    render(
      <>
        <h2>Workspace Index</h2>
        <SearchCollectionPicker />
      </>
    );

    expect(screen.getAllByText('Workspace Index')).toHaveLength(2);
    expect(screen.getByTestId('workspace-search-single-collection')).toHaveTextContent(
      'Workspace Index'
    );
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('replaces the ready quiet label with the named picker when more rows arrive', () => {
    usePGliteLiveQueryMock.mockReturnValue({ rows: [managedRow] });
    const { rerender } = render(<SearchCollectionPicker />);
    expect(screen.getByTestId('workspace-search-single-collection')).toBeInTheDocument();

    usePGliteLiveQueryMock.mockReturnValue({
      rows: [managedRow, { ...managedRow, id: 'imported', name: 'Imported set', systemRole: null }],
    });
    rerender(<SearchCollectionPicker />);

    expect(screen.queryByTestId('workspace-search-single-collection')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Search collection' })).toBeVisible();
  });

  it('removes the readiness marker if the live rows become empty again', () => {
    usePGliteLiveQueryMock.mockReturnValue({ rows: [managedRow] });
    const { rerender } = render(<SearchCollectionPicker />);
    expect(screen.getByTestId('workspace-search-single-collection')).toBeInTheDocument();

    usePGliteLiveQueryMock.mockReturnValue({ rows: [] });
    rerender(<SearchCollectionPicker />);

    expect(screen.getByText('Workspace Index')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-search-single-collection')).not.toBeInTheDocument();
  });
});
