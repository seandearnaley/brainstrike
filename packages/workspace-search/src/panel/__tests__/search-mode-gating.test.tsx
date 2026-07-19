import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceSearchStore } from '../../core/workspace-search-store';
import type { CollectionStatsRow } from '../collection-stats-query';
import { SearchModeToggle } from '../search-mode-toggle';
import {
  SEMANTIC_UNAVAILABLE_NO_CHUNKS,
  useSemanticAvailability,
} from '../use-semantic-availability';

const { usePGliteLiveQueryMock } = vi.hoisted(() => ({
  usePGliteLiveQueryMock: vi.fn(),
}));

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: (...args: unknown[]) => JSON.stringify(args),
  usePGliteLiveQuery: usePGliteLiveQueryMock,
}));

function makeRow(overrides: Partial<CollectionStatsRow> = {}): CollectionStatsRow {
  return {
    chunkCount: 0,
    embeddedChunkCount: 0,
    fileCount: 0,
    id: 'workspace-index',
    name: 'Workspace Index',
    pendingChunkCount: 0,
    systemRole: 'workspace-index',
    ...overrides,
  };
}

function mockRows(rows: CollectionStatsRow[]): void {
  usePGliteLiveQueryMock.mockImplementation(() => ({
    error: null,
    loading: false,
    refresh: vi.fn(),
    rows,
  }));
}

describe('useSemanticAvailability', () => {
  beforeEach(() => {
    useWorkspaceSearchStore.getState().reset();
    vi.clearAllMocks();
  });

  it('gates with the no-chunks reason when the effective set has zero embedded chunks', () => {
    mockRows([makeRow({ embeddedChunkCount: 0 })]);
    let result: ReturnType<typeof useSemanticAvailability> | null = null;
    function Probe(): null {
      result = useSemanticAvailability(null);
      return null;
    }
    render(<Probe />);

    expect(result).toEqual({ available: false, reason: SEMANTIC_UNAVAILABLE_NO_CHUNKS });
  });

  it('is available when the effective set has embedded chunks', () => {
    mockRows([makeRow({ embeddedChunkCount: 42 })]);
    let result: ReturnType<typeof useSemanticAvailability> | null = null;
    function Probe(): null {
      result = useSemanticAvailability(null);
      return null;
    }
    render(<Probe />);

    expect(result).toEqual({ available: true, reason: null });
  });

  it('does not gate (optimistic) when no stats row is resolved yet', () => {
    mockRows([]);
    let result: ReturnType<typeof useSemanticAvailability> | null = null;
    function Probe(): null {
      result = useSemanticAvailability(null);
      return null;
    }
    render(<Probe />);

    expect(result).toEqual({ available: true, reason: null });
  });

  it('does not gate when the set row exists but its joined stats are NULL (stats unknown, not zero)', () => {
    // LEFT JOIN with no collection_indexing_stats row yields NULL columns —
    // "unknown", which must stay optimistic like a missing row, never read as 0.
    mockRows([makeRow({ chunkCount: null, embeddedChunkCount: null, pendingChunkCount: null })]);
    let result: ReturnType<typeof useSemanticAvailability> | null = null;
    function Probe(): null {
      result = useSemanticAvailability(null);
      return null;
    }
    render(<Probe />);

    expect(result).toEqual({ available: true, reason: null });
  });
});

describe('SearchModeToggle — semantic gating', () => {
  beforeEach(() => {
    useWorkspaceSearchStore.getState().reset();
    vi.clearAllMocks();
  });

  it('enabled path: Semantic is clickable and switches mode when chunks exist', () => {
    mockRows([makeRow({ embeddedChunkCount: 10 })]);
    render(<SearchModeToggle />);

    const semantic = screen.getByRole('button', { name: 'Semantic' });
    expect(semantic).not.toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(semantic);
    expect(useWorkspaceSearchStore.getState().mode).toBe('semantic');
  });

  it('gated (b): disables Semantic, names the reason on focus, and blocks the click', async () => {
    mockRows([makeRow({ embeddedChunkCount: 0 })]);
    render(<SearchModeToggle />);

    const semantic = screen.getByRole('button', { name: 'Semantic' });
    expect(semantic).toHaveAttribute('aria-disabled', 'true');

    // Radix opens the tooltip immediately on keyboard focus (no hover delay),
    // which is deterministic under fireEvent.
    fireEvent.focus(semantic);
    const tips = await screen.findAllByText(SEMANTIC_UNAVAILABLE_NO_CHUNKS);
    expect(tips.length).toBeGreaterThan(0);

    fireEvent.click(semantic);
    expect(useWorkspaceSearchStore.getState().mode).toBe('text');
  });

  it('keeps the user-selected semantic mode when a gated stats snapshot arrives (no silent revert)', async () => {
    // Regression: clearEmbeddings/re-embed cycles legitimately write
    // embedded_chunk_count = 0 to collection_indexing_stats while the toggle
    // stays mounted (forceMount latch). That transient snapshot must gate the
    // Semantic BUTTON, never silently rewrite the user's chosen mode — the old
    // auto-revert left the store on 'text' after embeddings returned.
    mockRows([makeRow({ embeddedChunkCount: 10 })]);
    useWorkspaceSearchStore.getState().setMode('semantic');

    const { rerender } = render(<SearchModeToggle />);
    expect(screen.getByRole('button', { name: 'Semantic' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    mockRows([makeRow({ embeddedChunkCount: 0 })]);
    rerender(<SearchModeToggle />);

    // The gate shows (aria-disabled) but the selection is preserved.
    const semantic = screen.getByRole('button', { name: 'Semantic' });
    expect(semantic).toHaveAttribute('aria-disabled', 'true');
    expect(semantic).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(useWorkspaceSearchStore.getState().mode).toBe('semantic');
    });

    // Availability recovering leaves the selection intact and drops the gate.
    mockRows([makeRow({ embeddedChunkCount: 10 })]);
    rerender(<SearchModeToggle />);
    expect(screen.getByRole('button', { name: 'Semantic' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(useWorkspaceSearchStore.getState().mode).toBe('semantic');
  });

  it('while gated, the user can still switch to Text explicitly', () => {
    mockRows([makeRow({ embeddedChunkCount: 0 })]);
    useWorkspaceSearchStore.getState().setMode('semantic');
    render(<SearchModeToggle />);

    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    expect(useWorkspaceSearchStore.getState().mode).toBe('text');
  });
});
