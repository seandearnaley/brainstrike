import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchModeBar } from '../collection-browser/search-mode-bar';
import type { SearchModeBarProps } from '../collection-browser/types';

describe('SearchModeBar', () => {
  const createProps = (overrides: Partial<SearchModeBarProps> = {}): SearchModeBarProps => ({
    mode: 'semantic',
    onModeChange: vi.fn(),
    semanticQuery: '',
    onSemanticQueryChange: vi.fn(),
    onSemanticSearch: vi.fn(),
    isSearching: false,
    isConfigExpanded: false,
    onConfigExpandedChange: vi.fn(),
    hasSearched: false,
    ...overrides,
  });

  const SEARCH_PLACEHOLDER = /Ask a question... \(Cmd\+Enter\)/i;

  it('renders semantic search input', () => {
    render(<SearchModeBar {...createProps()} />);

    expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Query' })).toBeInTheDocument();
  });

  it('calls onSemanticQueryChange when typing in search input', () => {
    const onSemanticQueryChange = vi.fn();
    render(<SearchModeBar {...createProps({ onSemanticQueryChange })} />);

    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'test query' } });

    expect(onSemanticQueryChange).toHaveBeenCalledWith('test query');
  });

  it('shows clear button when query is not empty', () => {
    render(<SearchModeBar {...createProps({ semanticQuery: 'test' })} />);

    expect(screen.getByRole('button', { name: 'Clear query' })).toBeInTheDocument();
  });

  it('does not show clear button when query is empty', () => {
    render(<SearchModeBar {...createProps({ semanticQuery: '' })} />);

    expect(screen.queryByRole('button', { name: 'Clear query' })).not.toBeInTheDocument();
  });

  it('clears query when clear button is clicked', () => {
    const onSemanticQueryChange = vi.fn();
    render(<SearchModeBar {...createProps({ semanticQuery: 'test', onSemanticQueryChange })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear query' }));

    expect(onSemanticQueryChange).toHaveBeenCalledWith('');
  });

  it('exits semantic results when clearing the query after a search', () => {
    const onSemanticQueryChange = vi.fn();
    const onModeChange = vi.fn();

    render(
      <SearchModeBar
        {...createProps({
          hasSearched: true,
          mode: 'semantic',
          onModeChange,
          onSemanticQueryChange,
          semanticQuery: 'test',
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear query' }));

    expect(onSemanticQueryChange).toHaveBeenCalledWith('');
    expect(onModeChange).toHaveBeenCalledWith('quick');
  });

  it('exits semantic results when the query is manually cleared', () => {
    const onSemanticQueryChange = vi.fn();
    const onModeChange = vi.fn();

    render(
      <SearchModeBar
        {...createProps({
          hasSearched: true,
          mode: 'semantic',
          onModeChange,
          onSemanticQueryChange,
          semanticQuery: 'test',
        })}
      />
    );

    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.change(input, { target: { value: '' } });

    expect(onSemanticQueryChange).toHaveBeenCalledWith('');
    expect(onModeChange).toHaveBeenCalledWith('quick');
  });

  it('disables search button when query is empty', () => {
    render(<SearchModeBar {...createProps({ semanticQuery: '' })} />);

    expect(screen.getByRole('button', { name: 'Query' })).toBeDisabled();
  });

  it('disables search button when searching', () => {
    render(<SearchModeBar {...createProps({ semanticQuery: 'test', isSearching: true })} />);

    // Button should be disabled but text might be different (Query) or just disabled state
    expect(screen.getByRole('button', { name: 'Query' })).toBeDisabled();
  });

  it('calls onSemanticSearch when search button is clicked', () => {
    const onSemanticSearch = vi.fn();
    render(<SearchModeBar {...createProps({ semanticQuery: 'test', onSemanticSearch })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Query' }));

    expect(onSemanticSearch).toHaveBeenCalled();
  });

  it('shows expand/collapse buttons when handlers provided', () => {
    const onExpandAll = vi.fn();
    const onCollapseAll = vi.fn();
    render(<SearchModeBar {...createProps({ onExpandAll, onCollapseAll })} />);

    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
  });

  it('calls onExpandAll when expand button is clicked', () => {
    const onExpandAll = vi.fn();
    render(<SearchModeBar {...createProps({ onExpandAll, onCollapseAll: vi.fn() })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));

    expect(onExpandAll).toHaveBeenCalled();
  });

  it('calls onCollapseAll when collapse button is clicked', () => {
    const onCollapseAll = vi.fn();
    render(<SearchModeBar {...createProps({ onExpandAll: vi.fn(), onCollapseAll })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));

    expect(onCollapseAll).toHaveBeenCalled();
  });

  it('triggers search on Cmd/Ctrl+Enter', () => {
    const onSemanticSearch = vi.fn();
    render(<SearchModeBar {...createProps({ semanticQuery: 'test', onSemanticSearch })} />);

    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    expect(onSemanticSearch).toHaveBeenCalled();
  });

  it('blurs input on Escape key', () => {
    render(<SearchModeBar {...createProps()} />);

    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
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

  describe('single-line constraint for semantic query textarea', () => {
    let scrollHeightSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Simulate content that would normally expand a multi-row textarea
      scrollHeightSpy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);
    });

    afterEach(() => {
      scrollHeightSpy.mockRestore();
    });

    it('limits the semantic search textarea to a single row height even with large content', () => {
      render(
        <SearchModeBar
          {...createProps({ semanticQuery: 'a very long query that\ncould span\nmultiple lines' })}
        />
      );

      const textarea = screen.getByRole('textbox', { name: 'Semantic search query' });
      // With maxRows=6 (before fix): calculatedMaxHeight = 120px → height = 120px
      // With maxRows=1 (after fix):  calculatedMaxHeight = 36px  → height = 36px
      const height = Number.parseInt((textarea as HTMLTextAreaElement).style.height, 10);
      expect(height).toBeLessThanOrEqual(36);
    });
  });

  it('shows filter toggle and settings buttons', () => {
    render(<SearchModeBar {...createProps()} />);

    expect(screen.getByRole('button', { name: 'Toggle filters' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle search settings' })).toBeInTheDocument();
  });

  it('uses aria-pressed to reflect filter panel visibility', () => {
    render(<SearchModeBar {...createProps({ isFilterVisible: true })} />);

    expect(screen.getByRole('button', { name: 'Toggle filters' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('uses aria-pressed to reflect search settings expansion', () => {
    render(<SearchModeBar {...createProps({ isConfigExpanded: true })} />);

    expect(screen.getByRole('button', { name: 'Toggle search settings' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('keeps the filter toggle unpressed when filters are active but the panel is closed', () => {
    render(
      <SearchModeBar
        {...createProps({
          filters: {
            embeddingStatus: 'all',
            nodeTypes: new Set(['collection', 'file', 'chunk']),
            searchMatchesOnly: false,
            searchQuery: '',
          },
          isFilterVisible: false,
        })}
      />
    );

    const filterToggle = screen.getByRole('button', { name: 'Toggle filters (active)' });
    expect(filterToggle).toHaveAttribute('aria-pressed', 'false');
    expect(filterToggle).toHaveClass('bg-accent');
  });

  it('renders multi-select toggle when onMultiSelectToggle is provided', () => {
    const onMultiSelectToggle = vi.fn();
    render(<SearchModeBar {...createProps({ onMultiSelectToggle })} />);

    expect(screen.getByRole('button', { name: 'Toggle multi-select' })).toBeInTheDocument();
  });

  it('does not render multi-select toggle when onMultiSelectToggle is not provided', () => {
    render(<SearchModeBar {...createProps()} />);

    expect(screen.queryByRole('button', { name: 'Toggle multi-select' })).not.toBeInTheDocument();
  });

  it('calls onMultiSelectToggle with toggled value when clicked', () => {
    const onMultiSelectToggle = vi.fn();
    render(<SearchModeBar {...createProps({ multiSelectEnabled: false, onMultiSelectToggle })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle multi-select' }));

    expect(onMultiSelectToggle).toHaveBeenCalledWith(true);
  });

  it('highlights multi-select toggle when enabled', () => {
    const onMultiSelectToggle = vi.fn();
    render(<SearchModeBar {...createProps({ multiSelectEnabled: true, onMultiSelectToggle })} />);

    const toggle = screen.getByRole('button', { name: 'Toggle multi-select' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle.className).toContain('bg-accent');
  });

  it('renders group-by button when onGroupByChange is provided', () => {
    const onGroupByChange = vi.fn();
    render(<SearchModeBar {...createProps({ onGroupByChange })} />);

    expect(screen.getByRole('button', { name: 'Group by' })).toBeInTheDocument();
  });

  it('does not render group-by button when onGroupByChange is not provided', () => {
    render(<SearchModeBar {...createProps()} />);

    expect(screen.queryByRole('button', { name: 'Group by' })).not.toBeInTheDocument();
  });

  it('highlights group-by button when groupBy is active', () => {
    const onGroupByChange = vi.fn();
    render(<SearchModeBar {...createProps({ groupBy: 'status', onGroupByChange })} />);

    const groupByBtn = screen.getByRole('button', { name: 'Group by' });
    expect(groupByBtn.className).toContain('bg-accent');
  });
});
