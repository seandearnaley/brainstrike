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
    threshold: 0.5,
    resultLimit: 20,
    distanceMetric: 'cosine',
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

  it('calls onConfigChange when vector weight changes', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({
          onConfigChange,
          config: { ...createDefaultConfig(), retrievalMode: 'hybrid' },
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
        {...createProps({ onConfigChange, config: { ...createDefaultConfig(), threshold: 0.75 } })}
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

  it('accepts a large custom result limit and reports it via onConfigChange', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(<SearchConfigPanel {...createProps({ onConfigChange })} />);
    fireEvent.change(screen.getByLabelText('Result limit'), { target: { value: '5000' } });
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ resultLimit: 5000 }));
  });

  it('clamps the result limit to the 1–10000 range', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(<SearchConfigPanel {...createProps({ onConfigChange })} />);
    const input = screen.getByLabelText('Result limit');

    fireEvent.change(input, { target: { value: '0' } });
    expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ resultLimit: 1 }));

    fireEvent.change(input, { target: { value: '99999' } });
    expect(onConfigChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ resultLimit: 10_000 })
    );
  });

  it('ignores an empty / non-numeric result limit instead of writing NaN', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(<SearchConfigPanel {...createProps({ onConfigChange })} />);
    fireEvent.change(screen.getByLabelText('Result limit'), { target: { value: '' } });
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

  // === Distance metric ===

  it('displays the distance metric and a mismatch warning', () => {
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({
          config: { ...createDefaultConfig(), distanceMetric: 'cosine' },
          collectionDistanceMetric: 'l2',
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
          config: { ...createDefaultConfig(), distanceMetric: 'cosine' },
          collectionDistanceMetric: 'cosine',
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
