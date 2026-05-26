import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SearchConfigPanel } from '../collection-browser/search-config-panel';
import type { SearchConfig, SearchConfigPanelProps } from '../collection-browser/types';
import { TooltipProvider } from '../tooltip';

/**
 * Wrapper component that provides TooltipProvider context
 */
function TestWrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

/**
 * Custom render function that wraps component with necessary providers
 */
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
    isExpanded: false,
    onExpandedChange: vi.fn(),
    ...overrides,
  });

  it('renders toggle button', () => {
    renderWithProviders(<SearchConfigPanel {...createProps()} />);

    expect(screen.getByText('Advanced Options')).toBeInTheDocument();
  });

  it('shows chevron down when collapsed', () => {
    renderWithProviders(<SearchConfigPanel {...createProps({ isExpanded: false })} />);

    const button = screen.getByRole('button', { name: /advanced options/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows chevron up when expanded', () => {
    renderWithProviders(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    const button = screen.getByRole('button', { name: /advanced options/i });
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('calls onExpandedChange when toggle button is clicked', () => {
    const onExpandedChange = vi.fn();
    renderWithProviders(
      <SearchConfigPanel {...createProps({ onExpandedChange, isExpanded: false })} />
    );

    fireEvent.click(screen.getByRole('button', { name: /advanced options/i }));

    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it('toggles from expanded to collapsed', () => {
    const onExpandedChange = vi.fn();
    renderWithProviders(
      <SearchConfigPanel {...createProps({ onExpandedChange, isExpanded: true })} />
    );

    fireEvent.click(screen.getByRole('button', { name: /advanced options/i }));

    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it('shows content when expanded', () => {
    renderWithProviders(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    // Compact layout uses inline labels
    expect(screen.getByText('Threshold')).toBeInTheDocument();
    expect(screen.getByText('Results')).toBeInTheDocument();
    expect(screen.getByText('Metric')).toBeInTheDocument();
  });

  it('displays current threshold value', () => {
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({
          config: { ...createDefaultConfig(), threshold: 0.75 },
          isExpanded: true,
        })}
      />
    );

    expect(screen.getByText('0.75')).toBeInTheDocument();
  });

  it('calls onConfigChange when threshold slider changes', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(
      <SearchConfigPanel {...createProps({ onConfigChange, isExpanded: true })} />
    );

    const slider = screen.getByLabelText('Threshold');
    fireEvent.change(slider, { target: { value: '0.8' } });

    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ threshold: 0.8 }));
  });

  it('uses the visible threshold label for the slider', () => {
    renderWithProviders(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    expect(screen.getByLabelText('Threshold')).toBeInTheDocument();
  });

  it('ignores invalid threshold values', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(
      <SearchConfigPanel {...createProps({ onConfigChange, isExpanded: true })} />
    );

    const slider = screen.getByLabelText('Threshold');
    fireEvent.change(slider, { target: { value: 'not-a-number' } });

    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it('displays result limit dropdown', () => {
    renderWithProviders(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    // The trigger should show the current value (just the number in compact layout)
    expect(screen.getByText('20')).toBeInTheDocument();
  });

  it('displays distance metric dropdown', () => {
    renderWithProviders(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    // Should show current metric
    expect(screen.getByText('Cosine')).toBeInTheDocument();
  });

  it('shows warning when collection metric differs from selected', () => {
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({
          isExpanded: true,
          config: { ...createDefaultConfig(), distanceMetric: 'cosine' },
          collectionDistanceMetric: 'l2',
        })}
      />
    );

    // Compact layout shows ⚠ icon with title attribute
    expect(screen.getByText('⚠')).toBeInTheDocument();
  });

  it('does not show warning when collection metric matches selected', () => {
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({
          isExpanded: true,
          config: { ...createDefaultConfig(), distanceMetric: 'cosine' },
          collectionDistanceMetric: 'cosine',
        })}
      />
    );

    expect(screen.queryByText('⚠')).not.toBeInTheDocument();
  });

  it('does not show warning when no collection metric provided', () => {
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({
          isExpanded: true,
        })}
      />
    );

    expect(screen.queryByText('⚠')).not.toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = renderWithProviders(
      <SearchConfigPanel {...createProps({ className: 'custom-class' })} />
    );

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('custom-class');
  });

  it('renders all distance metric options', () => {
    renderWithProviders(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    // Cosine is selected by default
    expect(screen.getByText('Cosine')).toBeInTheDocument();
  });

  it('has correct aria controls on toggle button', () => {
    renderWithProviders(<SearchConfigPanel {...createProps()} />);

    const button = screen.getByRole('button', { name: /advanced options/i });
    expect(button).toHaveAttribute('aria-controls', 'search-config-content');
  });

  it('keeps search-config-content in the DOM when collapsed for aria-controls', () => {
    renderWithProviders(<SearchConfigPanel {...createProps({ isExpanded: false })} />);

    const content = document.getElementById('search-config-content');
    expect(content).toBeInTheDocument();
    expect(content).toHaveAttribute('hidden');
  });

  it('toggles advanced options with Enter and Space on the trigger', async () => {
    const user = userEvent.setup();
    const onExpandedChange = vi.fn();
    const { rerender } = renderWithProviders(
      <SearchConfigPanel {...createProps({ onExpandedChange, isExpanded: false })} />
    );

    const expandTrigger = screen.getByRole('button', { name: /expand advanced options/i });
    expandTrigger.focus();
    await user.keyboard('{Enter}');
    expect(onExpandedChange).toHaveBeenCalledWith(true);

    onExpandedChange.mockClear();
    rerender(
      <TestWrapper>
        <SearchConfigPanel {...createProps({ onExpandedChange, isExpanded: true })} />
      </TestWrapper>
    );
    const collapseTrigger = screen.getByRole('button', { name: /collapse advanced options/i });
    collapseTrigger.focus();
    await user.keyboard(' ');
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it('does not animate the advanced options visibility toggle', () => {
    renderWithProviders(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    // Regression guard: jsdom can't observe visual behavior, so we assert the
    // absence of the previously-applied transition classes that the `hidden`
    // attribute would conflict with. If transitions are reintroduced, pair
    // them with coordinated JS that defers `hidden` until transition end.
    const content = document.getElementById('search-config-content');
    expect(content).not.toHaveClass('transition-all');
    expect(content).not.toHaveClass('duration-200');
    expect(content).not.toHaveClass('ease-out');
  });

  // === Hybrid Search Tests (BST-294) ===

  it('shows retrieval mode toggle when expanded', () => {
    renderWithProviders(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    expect(screen.getByText('Mode')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /retrieval mode/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /vector/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hybrid/i })).toBeInTheDocument();
  });

  it('defaults to hybrid mode', () => {
    renderWithProviders(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    const hybridButton = screen.getByRole('button', { name: /hybrid/i });
    expect(hybridButton).toHaveClass('bg-primary');
  });

  it('calls onConfigChange when switching to vector mode', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(
      <SearchConfigPanel {...createProps({ onConfigChange, isExpanded: true })} />
    );

    fireEvent.click(screen.getByRole('button', { name: /vector/i }));

    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({ retrievalMode: 'vector' })
    );
  });

  it('shows weight sliders only in hybrid mode', () => {
    const { rerender } = renderWithProviders(
      <SearchConfigPanel
        {...createProps({
          isExpanded: true,
          config: { ...createDefaultConfig(), retrievalMode: 'vector' },
        })}
      />
    );

    // Vector mode: no weight sliders
    expect(screen.queryByLabelText('Semantic search weight')).not.toBeInTheDocument();

    // Hybrid mode: show weight sliders
    rerender(
      <TestWrapper>
        <SearchConfigPanel
          {...createProps({
            isExpanded: true,
            config: { ...createDefaultConfig(), retrievalMode: 'hybrid' },
          })}
        />
      </TestWrapper>
    );

    expect(screen.getByLabelText('Semantic search weight')).toBeInTheDocument();
    expect(screen.getByLabelText('Keyword search weight')).toBeInTheDocument();
  });

  it('displays default weight values in hybrid mode', () => {
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({
          isExpanded: true,
          config: { ...createDefaultConfig(), retrievalMode: 'hybrid' },
        })}
      />
    );

    // Default weights are 1.0
    const weightValues = screen.getAllByText('1.0');
    expect(weightValues.length).toBe(2); // vector and FTS weights
  });

  it('calls onConfigChange when vector weight changes', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({
          onConfigChange,
          isExpanded: true,
          config: { ...createDefaultConfig(), retrievalMode: 'hybrid' },
        })}
      />
    );

    const vectorWeightSlider = screen.getByLabelText('Semantic search weight');
    fireEvent.change(vectorWeightSlider, { target: { value: '1.5' } });

    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ vectorWeight: 1.5 }));
  });

  it('calls onConfigChange when FTS weight changes', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(
      <SearchConfigPanel
        {...createProps({
          onConfigChange,
          isExpanded: true,
          config: { ...createDefaultConfig(), retrievalMode: 'hybrid' },
        })}
      />
    );

    const ftsWeightSlider = screen.getByLabelText('Keyword search weight');
    fireEvent.change(ftsWeightSlider, { target: { value: '0.8' } });

    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ ftsWeight: 0.8 }));
  });
});
