import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchModeBar } from '../collection-browser/search-mode-bar';
import type { SearchConfig, SearchModeBarProps } from '../collection-browser/types';

describe('SearchModeBar', () => {
  const createDefaultConfig = (): SearchConfig => ({
    threshold: 0.5,
    resultLimit: 20,
    distanceMetric: 'cosine',
  });

  const createProps = (overrides: Partial<SearchModeBarProps> = {}): SearchModeBarProps => ({
    mode: 'quick',
    onModeChange: vi.fn(),
    semanticQuery: '',
    onSemanticQueryChange: vi.fn(),
    onSemanticSearch: vi.fn(),
    isSearching: false,
    searchConfig: createDefaultConfig(),
    onSearchConfigChange: vi.fn(),
    isConfigExpanded: false,
    onConfigExpandedChange: vi.fn(),
    hasSearched: false,
    ...overrides,
  });

  it('renders mode tabs', () => {
    render(<SearchModeBar {...createProps()} />);

    expect(screen.getByText('Quick Filter')).toBeInTheDocument();
    expect(screen.getByText('Semantic Search')).toBeInTheDocument();
  });

  it('highlights the active mode tab', () => {
    render(<SearchModeBar {...createProps({ mode: 'quick' })} />);

    const quickTab = screen.getByRole('tab', { name: /Quick Filter/ });
    expect(quickTab).toHaveAttribute('aria-selected', 'true');
  });

  it('calls onModeChange when switching modes', () => {
    const onModeChange = vi.fn();
    render(<SearchModeBar {...createProps({ mode: 'quick', onModeChange })} />);

    fireEvent.click(screen.getByText('Semantic Search'));

    expect(onModeChange).toHaveBeenCalledWith('semantic');
  });

  it('does not call onModeChange when clicking current mode', () => {
    const onModeChange = vi.fn();
    render(<SearchModeBar {...createProps({ mode: 'quick', onModeChange })} />);

    fireEvent.click(screen.getByText('Quick Filter'));

    expect(onModeChange).not.toHaveBeenCalled();
  });

  it('shows semantic search panel in semantic mode', () => {
    render(<SearchModeBar {...createProps({ mode: 'semantic' })} />);

    expect(screen.getByPlaceholderText(/Enter semantic search query/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
  });

  it('does not show semantic search panel in quick mode', () => {
    render(<SearchModeBar {...createProps({ mode: 'quick' })} />);

    expect(screen.queryByPlaceholderText(/Enter semantic search query/)).not.toBeInTheDocument();
  });

  it('calls onSemanticQueryChange when typing in search input', () => {
    const onSemanticQueryChange = vi.fn();
    render(<SearchModeBar {...createProps({ mode: 'semantic', onSemanticQueryChange })} />);

    const input = screen.getByPlaceholderText(/Enter semantic search query/);
    fireEvent.change(input, { target: { value: 'test query' } });

    expect(onSemanticQueryChange).toHaveBeenCalledWith('test query');
  });

  it('shows clear button when query is not empty', () => {
    render(<SearchModeBar {...createProps({ mode: 'semantic', semanticQuery: 'test' })} />);

    expect(screen.getByRole('button', { name: 'Clear query' })).toBeInTheDocument();
  });

  it('does not show clear button when query is empty', () => {
    render(<SearchModeBar {...createProps({ mode: 'semantic', semanticQuery: '' })} />);

    expect(screen.queryByRole('button', { name: 'Clear query' })).not.toBeInTheDocument();
  });

  it('clears query when clear button is clicked', () => {
    const onSemanticQueryChange = vi.fn();
    render(
      <SearchModeBar
        {...createProps({ mode: 'semantic', semanticQuery: 'test', onSemanticQueryChange })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear query' }));

    expect(onSemanticQueryChange).toHaveBeenCalledWith('');
  });

  it('disables search button when query is empty', () => {
    render(<SearchModeBar {...createProps({ mode: 'semantic', semanticQuery: '' })} />);

    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
  });

  it('disables search button when searching', () => {
    render(
      <SearchModeBar
        {...createProps({ mode: 'semantic', semanticQuery: 'test', isSearching: true })}
      />
    );

    expect(screen.getByRole('button', { name: /Searching/ })).toBeDisabled();
  });

  it('calls onSemanticSearch when search button is clicked', () => {
    const onSemanticSearch = vi.fn();
    render(
      <SearchModeBar
        {...createProps({ mode: 'semantic', semanticQuery: 'test', onSemanticSearch })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(onSemanticSearch).toHaveBeenCalled();
  });

  it('shows loading state when searching', () => {
    render(
      <SearchModeBar
        {...createProps({ mode: 'semantic', semanticQuery: 'test', isSearching: true })}
      />
    );

    expect(screen.getByText('Searching...')).toBeInTheDocument();
  });

  it('shows expand/collapse buttons in quick mode when handlers provided', () => {
    const onExpandAll = vi.fn();
    const onCollapseAll = vi.fn();
    render(<SearchModeBar {...createProps({ mode: 'quick', onExpandAll, onCollapseAll })} />);

    expect(screen.getByRole('button', { name: 'Expand all nodes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all nodes' })).toBeInTheDocument();
  });

  it('does not show expand/collapse buttons in semantic mode', () => {
    const onExpandAll = vi.fn();
    const onCollapseAll = vi.fn();
    render(<SearchModeBar {...createProps({ mode: 'semantic', onExpandAll, onCollapseAll })} />);

    expect(screen.queryByRole('button', { name: 'Expand all nodes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collapse all nodes' })).not.toBeInTheDocument();
  });

  it('calls onExpandAll when expand button is clicked', () => {
    const onExpandAll = vi.fn();
    render(
      <SearchModeBar {...createProps({ mode: 'quick', onExpandAll, onCollapseAll: vi.fn() })} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand all nodes' }));

    expect(onExpandAll).toHaveBeenCalled();
  });

  it('calls onCollapseAll when collapse button is clicked', () => {
    const onCollapseAll = vi.fn();
    render(
      <SearchModeBar {...createProps({ mode: 'quick', onExpandAll: vi.fn(), onCollapseAll })} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all nodes' }));

    expect(onCollapseAll).toHaveBeenCalled();
  });

  it('displays result count in quick mode', () => {
    render(<SearchModeBar {...createProps({ mode: 'quick', resultCount: 5, totalCount: 10 })} />);

    expect(screen.getByText('5 of 10')).toBeInTheDocument();
  });

  it('displays match count in semantic mode after search', () => {
    render(
      <SearchModeBar
        {...createProps({ mode: 'semantic', resultCount: 5, totalCount: 10, hasSearched: true })}
      />
    );

    expect(screen.getByText('5 matches')).toBeInTheDocument();
  });

  it('displays singular match text for 1 result', () => {
    render(
      <SearchModeBar
        {...createProps({ mode: 'semantic', resultCount: 1, totalCount: 10, hasSearched: true })}
      />
    );

    expect(screen.getByText('1 match')).toBeInTheDocument();
  });

  it('triggers search on Cmd/Ctrl+Enter', () => {
    const onSemanticSearch = vi.fn();
    render(
      <SearchModeBar
        {...createProps({ mode: 'semantic', semanticQuery: 'test', onSemanticSearch })}
      />
    );

    const input = screen.getByPlaceholderText(/Enter semantic search query/);
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    expect(onSemanticSearch).toHaveBeenCalled();
  });

  it('does not trigger search on Cmd/Ctrl+Enter when already searching', () => {
    const onSemanticSearch = vi.fn();
    render(
      <SearchModeBar
        {...createProps({
          mode: 'semantic',
          semanticQuery: 'test',
          onSemanticSearch,
          isSearching: true,
        })}
      />
    );

    const input = screen.getByPlaceholderText(/Enter semantic search query/);
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    expect(onSemanticSearch).not.toHaveBeenCalled();
  });

  it('does not trigger search on Cmd/Ctrl+Enter when query is empty', () => {
    const onSemanticSearch = vi.fn();
    render(
      <SearchModeBar
        {...createProps({ mode: 'semantic', semanticQuery: '   ', onSemanticSearch })}
      />
    );

    const input = screen.getByPlaceholderText(/Enter semantic search query/);
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    expect(onSemanticSearch).not.toHaveBeenCalled();
  });

  it('blurs input on Escape key', () => {
    render(<SearchModeBar {...createProps({ mode: 'semantic' })} />);

    const input = screen.getByPlaceholderText(/Enter semantic search query/);
    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(document.activeElement).not.toBe(input);
  });

  it('applies custom className', () => {
    const { container } = render(<SearchModeBar {...createProps({ className: 'custom-class' })} />);

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('custom-class');
  });

  it('shows keyboard hint text', () => {
    render(<SearchModeBar {...createProps({ mode: 'semantic' })} />);

    expect(screen.getByText('Cmd/Ctrl+Enter to search')).toBeInTheDocument();
  });

  it('hides clear button when searching', () => {
    render(
      <SearchModeBar
        {...createProps({ mode: 'semantic', semanticQuery: 'test', isSearching: true })}
      />
    );

    expect(screen.queryByRole('button', { name: 'Clear query' })).not.toBeInTheDocument();
  });
});
