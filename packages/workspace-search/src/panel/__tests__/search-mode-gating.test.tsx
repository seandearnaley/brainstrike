import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceSearchStore } from '../../core/workspace-search-store';
import { SearchModeToggle } from '../search-mode-toggle';
import {
  SEMANTIC_UNAVAILABLE_NO_CHUNKS,
  type SemanticAvailability,
} from '../semantic-availability';

const AVAILABLE: SemanticAvailability = { available: true, reason: null };
const GATED: SemanticAvailability = { available: false, reason: SEMANTIC_UNAVAILABLE_NO_CHUNKS };

describe('SearchModeToggle — semantic gating', () => {
  beforeEach(() => {
    useWorkspaceSearchStore.getState().reset();
  });

  it('enabled path: Semantic is clickable and switches mode when chunks exist', () => {
    render(<SearchModeToggle semanticAvailability={AVAILABLE} />);

    const semantic = screen.getByRole('button', { name: 'Semantic' });
    expect(semantic).not.toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(semantic);
    expect(useWorkspaceSearchStore.getState().mode).toBe('semantic');
  });

  it('gated (b): disables Semantic, names the reason on focus, and blocks the click', async () => {
    render(<SearchModeToggle semanticAvailability={GATED} />);

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
    useWorkspaceSearchStore.getState().setMode('semantic');

    const { rerender } = render(<SearchModeToggle semanticAvailability={AVAILABLE} />);
    expect(screen.getByRole('button', { name: 'Semantic' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    rerender(<SearchModeToggle semanticAvailability={GATED} />);

    // The gate shows (aria-disabled) but the selection is preserved.
    const semantic = screen.getByRole('button', { name: 'Semantic' });
    expect(semantic).toHaveAttribute('aria-disabled', 'true');
    expect(semantic).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(useWorkspaceSearchStore.getState().mode).toBe('semantic');
    });

    // Availability recovering leaves the selection intact and drops the gate.
    rerender(<SearchModeToggle semanticAvailability={AVAILABLE} />);
    expect(screen.getByRole('button', { name: 'Semantic' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(useWorkspaceSearchStore.getState().mode).toBe('semantic');
  });

  it('while gated, the user can still switch to Text explicitly', () => {
    useWorkspaceSearchStore.getState().setMode('semantic');
    render(<SearchModeToggle semanticAvailability={GATED} />);

    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    expect(useWorkspaceSearchStore.getState().mode).toBe('text');
  });
});
