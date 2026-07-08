import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchConfigPanel } from '../collection-browser/search-config-panel';
import type { SearchConfig, SearchConfigPanelProps } from '../collection-browser/types';
import { TooltipProvider } from '../tooltip';

function TestWrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

function renderWithProviders(ui: React.ReactElement) {
  return render(ui, { wrapper: TestWrapper });
}

describe('SearchConfigPanel', () => {
  const createDefaultConfig = (): SearchConfig => ({
    distanceMetric: 'cosine',
    resultLimit: 20,
    threshold: 0.5,
  });

  const createProps = (
    overrides: Partial<SearchConfigPanelProps> = {}
  ): SearchConfigPanelProps => ({
    config: createDefaultConfig(),
    onConfigChange: vi.fn(),
    ...overrides,
  });

  // The panel is now pure popover content: it renders its controls directly,
  // with no self-managed accordion toggle (the cog Popover owns open/close).
  it('renders controls directly without an "Advanced Options" accordion toggle', () => {
    renderWithProviders(<SearchConfigPanel {...createProps()} />);

    expect(screen.queryByRole('button', { name: /advanced options/i })).not.toBeInTheDocument();
    expect(screen.getByText('Threshold')).toBeInTheDocument();
    expect(screen.getByText('Results')).toBeInTheDocument();
    expect(screen.getByText('Metric')).toBeInTheDocument();
  });

  it('shows the retrieval mode toggle', () => {
    renderWithProviders(<SearchConfigPanel {...createProps()} />);

    expect(screen.getByText('Mode')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /retrieval mode/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /vector/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hybrid/i })).toBeInTheDocument();
  });

  it('defaults to hybrid mode', () => {
    renderWithProviders(<SearchConfigPanel {...createProps()} />);
    expect(screen.getByRole('button', { name: /hybrid/i })).toHaveClass('bg-primary');
  });

  it('calls onConfigChange when switching to vector mode', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(<SearchConfigPanel {...createProps({ onConfigChange })} />);

    fireEvent.click(screen.getByRole('button', { name: /vector/i }));

    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({ retrievalMode: 'vector' })
    );
  });

  it('shows weight sliders only in hybrid mode', () => {
    const { rerender } = renderWithProviders(
      <SearchConfigPanel
        {...createProps({ config: { ...createDefaultConfig(), retrievalMode: 'vector' } })}
      />
    );
    expect(screen.queryByLabelText('Semantic search weight')).not.toBeInTheDocument();

    rerender(
      <TestWrapper>
        <SearchConfigPanel
          {...createProps({ config: { ...createDefaultConfig(), retrievalMode: 'hybrid' } })}
        />
      </TestWrapper>
    );
    expect(screen.getByLabelText('Semantic search weight')).toBeInTheDocument();
    expect(screen.getByLabelText('Keyword search weight')).toBeInTheDocument();
  });

  it('lets every range slider shrink to fit so it cannot overflow the popover (min-w-0)', () => {
    // Regression guard for the flexbox min-width:auto trap: native range inputs
    // report an intrinsic width, so without min-w-0 a flex-1 slider refuses to
    // shrink and spills out of the narrow cog popover.
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({ config: { ...createDefaultConfig(), retrievalMode: 'hybrid' } })}
      />
    );
    const sliders = [
      screen.getByLabelText('Threshold'),
      screen.getByLabelText('Semantic search weight'),
      screen.getByLabelText('Keyword search weight'),
    ];
    for (const slider of sliders) {
      expect(slider).toHaveClass('min-w-0');
      expect(slider).toHaveClass('flex-1');
    }
  });

  it('stacks the hybrid weight sliders as full-width labeled rows', () => {
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({ config: { ...createDefaultConfig(), retrievalMode: 'hybrid' } })}
      />
    );
    // Each weight is its own row with a visible label so it gets the full track
    // width instead of two half-width sliders fighting for space.
    expect(screen.getByText('Semantic')).toBeInTheDocument();
    expect(screen.getByText('Keyword')).toBeInTheDocument();
  });

  it('calls onConfigChange when vector weight changes', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({
          config: { ...createDefaultConfig(), retrievalMode: 'hybrid' },
          onConfigChange,
        })}
      />
    );
    fireEvent.change(screen.getByLabelText('Semantic search weight'), { target: { value: '1.5' } });
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ vectorWeight: 1.5 }));
  });

  it('displays and updates the threshold slider', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({ config: { ...createDefaultConfig(), threshold: 0.75 }, onConfigChange })}
      />
    );
    expect(screen.getByText('0.75')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Threshold'), { target: { value: '0.8' } });
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ threshold: 0.8 }));
  });

  it('ignores invalid threshold values', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(<SearchConfigPanel {...createProps({ onConfigChange })} />);
    fireEvent.change(screen.getByLabelText('Threshold'), { target: { value: 'not-a-number' } });
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  // === Result limit: free number input (replaces the 5–100 dropdown) ===

  it('renders the result limit as an editable number input showing the current value', () => {
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({ config: { ...createDefaultConfig(), resultLimit: 20 } })}
      />
    );
    const input = screen.getByLabelText('Result limit');
    expect(input).toHaveAttribute('type', 'number');
    expect(input).toHaveValue(20);
  });

  it('commits a large custom result limit on blur', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(<SearchConfigPanel {...createProps({ onConfigChange })} />);
    const input = screen.getByLabelText('Result limit');
    fireEvent.change(input, { target: { value: '1500' } });
    fireEvent.blur(input);
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ resultLimit: 1500 }));
  });

  it('clamps the result limit to the 1–2000 range on commit', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(<SearchConfigPanel {...createProps({ onConfigChange })} />);
    const input = screen.getByLabelText('Result limit');

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ resultLimit: 1 }));

    fireEvent.change(input, { target: { value: '99999' } });
    fireEvent.blur(input);
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ resultLimit: 2000 }));
  });

  it('parses exponent entries a number input allows instead of truncating the mantissa', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(<SearchConfigPanel {...createProps({ onConfigChange })} />);
    const input = screen.getByLabelText('Result limit');
    // A type="number" input accepts "2e3"; parseInt would commit 2, parseFloat → 2000.
    fireEvent.change(input, { target: { value: '2e3' } });
    fireEvent.blur(input);
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ resultLimit: 2000 }));
  });

  it('exposes the 2000 ceiling on the number input', () => {
    renderWithProviders(<SearchConfigPanel {...createProps()} />);
    expect(screen.getByLabelText('Result limit')).toHaveAttribute('max', '2000');
  });

  it('lets the field be cleared mid-edit without snapping back, and does not commit empty', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(<SearchConfigPanel {...createProps({ onConfigChange })} />);
    const input = screen.getByLabelText('Result limit');

    // Backspacing to empty must stick (draft state), not revert to the number.
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue(null);
    expect(onConfigChange).not.toHaveBeenCalled();

    // Committing an empty field keeps the previous value (no NaN write).
    fireEvent.blur(input);
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it('does not clamp a leading zero while typing (only on commit)', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(<SearchConfigPanel {...createProps({ onConfigChange })} />);
    const input = screen.getByLabelText('Result limit');
    fireEvent.change(input, { target: { value: '0' } });
    // While editing, the keystroke is preserved (not snapped to 1) and nothing committed yet.
    expect(input).toHaveValue(0);
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it('shows a soft performance hint only for large result limits', () => {
    const { rerender } = renderWithProviders(
      <SearchConfigPanel
        {...createProps({ config: { ...createDefaultConfig(), resultLimit: 100 } })}
      />
    );
    expect(screen.queryByText(/rank slower/i)).not.toBeInTheDocument();

    rerender(
      <TestWrapper>
        <SearchConfigPanel
          {...createProps({ config: { ...createDefaultConfig(), resultLimit: 5000 } })}
        />
      </TestWrapper>
    );
    expect(screen.getByText(/rank slower/i)).toBeInTheDocument();
  });

  it('shows the performance hint live from the draft, before blur/commit', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({ config: { ...createDefaultConfig(), resultLimit: 20 }, onConfigChange })}
      />
    );
    const input = screen.getByLabelText('Result limit');

    // Committed value is small, so no hint yet.
    expect(screen.queryByText(/rank slower/i)).not.toBeInTheDocument();

    // Typing a large value must surface the hint immediately — that's the
    // moment the user most benefits from it — not only after blur.
    fireEvent.change(input, { target: { value: '1500' } });
    expect(screen.getByText(/rank slower/i)).toBeInTheDocument();
    // ...and it's still just a draft (not committed).
    expect(onConfigChange).not.toHaveBeenCalled();

    // Editing back down to a small value hides it again, live.
    fireEvent.change(input, { target: { value: '50' } });
    expect(screen.queryByText(/rank slower/i)).not.toBeInTheDocument();
  });

  it('hides the live hint when the field is cleared, even over a large committed value', () => {
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({ config: { ...createDefaultConfig(), resultLimit: 2000 } })}
      />
    );
    // Committed 2000 is large, so the hint shows initially (not editing).
    expect(screen.getByText(/rank slower/i)).toBeInTheDocument();

    // Clearing the field mid-edit must hide the hint — the visible field is
    // blank, so it shouldn't read against the stale committed value.
    const input = screen.getByLabelText('Result limit');
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByText(/rank slower/i)).not.toBeInTheDocument();
  });

  it('drives the live hint with parseFloat so exponent drafts match commit semantics', () => {
    renderWithProviders(<SearchConfigPanel {...createProps()} />);
    const input = screen.getByLabelText('Result limit');
    // "2e3" commits to 2000 (> RESULT_LIMIT_LARGE), so the live hint must show
    // while editing — parseInt("2e3") === 2 would hide it inconsistently.
    fireEvent.change(input, { target: { value: '2e3' } });
    expect(screen.getByText(/rank slower/i)).toBeInTheDocument();
  });

  // === Distance metric ===

  it('displays the distance metric and a mismatch warning', () => {
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({
          collectionDistanceMetric: 'l2',
          config: { ...createDefaultConfig(), distanceMetric: 'cosine' },
        })}
      />
    );
    expect(screen.getByText('Cosine')).toBeInTheDocument();
    expect(screen.getByText('⚠')).toBeInTheDocument();
  });

  it('does not show the mismatch warning when metrics match', () => {
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({
          collectionDistanceMetric: 'cosine',
          config: { ...createDefaultConfig(), distanceMetric: 'cosine' },
        })}
      />
    );
    expect(screen.queryByText('⚠')).not.toBeInTheDocument();
  });

  it('applies a custom className', () => {
    const { container } = renderWithProviders(
      <SearchConfigPanel {...createProps({ className: 'custom-class' })} />
    );
    expect(container.firstChild as HTMLElement).toHaveClass('custom-class');
  });
});
