import { useExplorerColumnVisibilityStore } from '@brainstrike/app-state/stores/explorer-column-visibility-store';
import { TooltipProvider } from '@brainstrike/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExplorerColumnVisibilityControls } from '../shell/explorer-column-visibility-controls';
import {
  createExplorerThreadStatusStore,
  ExplorerThreadStatusContext,
} from '../shell/explorer-thread-status';
import { THREAD_KIND_APPEARANCE } from './thread-kind-appearance.fixture';

function optionLabels(): (string | null)[] {
  return screen.getAllByRole('checkbox').map((box) => {
    const id = box.getAttribute('id');
    return id ? (document.querySelector(`label[for="${id}"]`)?.textContent ?? null) : null;
  });
}

const withTooltips = {
  wrapper: ({ children }: { children: ReactNode }) => <TooltipProvider>{children}</TooltipProvider>,
};

beforeEach(() => {
  useExplorerColumnVisibilityStore.getState().reset();
});

describe('ExplorerColumnVisibilityControls', () => {
  it('does not offer This thread where no thread context is published (web)', () => {
    render(<ExplorerColumnVisibilityControls show />, withTooltips);
    fireEvent.click(screen.getByTestId('explorer-column-visibility-trigger'));
    expect(optionLabels()).toEqual(['Type', 'Tokens', 'Size']);
    expect(screen.getByText(/1 of 3 extra columns visible/u)).toBeInTheDocument();
  });

  it('offers This thread, on by default, where it can render', () => {
    render(
      <ExplorerThreadStatusContext.Provider
        value={createExplorerThreadStatusStore(THREAD_KIND_APPEARANCE)}
      >
        <ExplorerColumnVisibilityControls show />
      </ExplorerThreadStatusContext.Provider>,
      withTooltips
    );
    fireEvent.click(screen.getByTestId('explorer-column-visibility-trigger'));
    expect(optionLabels()).toEqual(['This thread', 'Type', 'Tokens', 'Size']);
    expect(screen.getByText(/2 of 4 extra columns visible/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'This thread' }));
    expect(useExplorerColumnVisibilityStore.getState().thread).toBe(false);
  });
});
