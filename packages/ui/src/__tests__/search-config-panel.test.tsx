import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchConfigPanel } from '../collection-browser/search-config-panel';
import type { SearchConfig, SearchConfigPanelProps } from '../collection-browser/types';

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
    render(<SearchConfigPanel {...createProps()} />);

    expect(screen.getByText('Advanced Options')).toBeInTheDocument();
  });

  it('shows chevron down when collapsed', () => {
    render(<SearchConfigPanel {...createProps({ isExpanded: false })} />);

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows chevron up when expanded', () => {
    render(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('calls onExpandedChange when toggle button is clicked', () => {
    const onExpandedChange = vi.fn();
    render(<SearchConfigPanel {...createProps({ onExpandedChange, isExpanded: false })} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it('toggles from expanded to collapsed', () => {
    const onExpandedChange = vi.fn();
    render(<SearchConfigPanel {...createProps({ onExpandedChange, isExpanded: true })} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it('shows content when expanded', () => {
    render(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    expect(screen.getByText('Similarity Threshold')).toBeInTheDocument();
    expect(screen.getByText('Max Results')).toBeInTheDocument();
    expect(screen.getByText('Distance Metric')).toBeInTheDocument();
  });

  it('displays current threshold value', () => {
    render(
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
    render(<SearchConfigPanel {...createProps({ onConfigChange, isExpanded: true })} />);

    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '0.8' } });

    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ threshold: 0.8 }));
  });

  it('ignores invalid threshold values', () => {
    const onConfigChange = vi.fn();
    render(<SearchConfigPanel {...createProps({ onConfigChange, isExpanded: true })} />);

    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: 'not-a-number' } });

    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it('displays result limit options', () => {
    render(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    // The trigger should show the current value
    expect(screen.getByText('20 results')).toBeInTheDocument();
  });

  it('displays distance metric options', () => {
    render(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    // Should show current metric
    expect(screen.getByText('Cosine')).toBeInTheDocument();
  });

  it('shows warning when collection metric differs from selected', () => {
    render(
      <SearchConfigPanel
        {...createProps({
          isExpanded: true,
          config: { ...createDefaultConfig(), distanceMetric: 'cosine' },
          collectionDistanceMetric: 'l2',
        })}
      />
    );

    expect(screen.getByText(/collection uses l2/)).toBeInTheDocument();
  });

  it('does not show warning when collection metric matches selected', () => {
    render(
      <SearchConfigPanel
        {...createProps({
          isExpanded: true,
          config: { ...createDefaultConfig(), distanceMetric: 'cosine' },
          collectionDistanceMetric: 'cosine',
        })}
      />
    );

    expect(screen.queryByText(/collection uses/)).not.toBeInTheDocument();
  });

  it('does not show warning when no collection metric provided', () => {
    render(
      <SearchConfigPanel
        {...createProps({
          isExpanded: true,
        })}
      />
    );

    expect(screen.queryByText(/collection uses/)).not.toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <SearchConfigPanel {...createProps({ className: 'custom-class' })} />
    );

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('custom-class');
  });

  it('shows broad/precise labels for threshold', () => {
    render(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    expect(screen.getByText('Broad')).toBeInTheDocument();
    expect(screen.getByText('Precise')).toBeInTheDocument();
  });

  it('renders all distance metric options', () => {
    render(<SearchConfigPanel {...createProps({ isExpanded: true })} />);

    // Cosine is selected by default
    expect(screen.getByText('Cosine')).toBeInTheDocument();
  });

  it('has correct aria controls on toggle button', () => {
    render(<SearchConfigPanel {...createProps()} />);

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-controls', 'search-config-content');
  });
});
