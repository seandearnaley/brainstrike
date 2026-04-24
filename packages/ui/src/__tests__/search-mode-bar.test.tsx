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
    isSearchExpanded: false,
    onSearchExpandedChange: vi.fn(),
    isConfigExpanded: false,
    onConfigExpandedChange: vi.fn(),
    hasSearched: false,
    ...overrides,
  });

  const SEARCH_PLACEHOLDER = /Describe what you want to find... \(Cmd\+Enter\)/i;

  it('renders a collapsed hybrid search trigger with explanatory copy', () => {
    render(<SearchModeBar {...createProps()} />);

    expect(screen.getByRole('button', { name: /hybrid search/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.getByText(/semantic similarity with keyword matches/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Hybrid search query' })).not.toBeInTheDocument();
  });

  it('calls onSearchExpandedChange when the hybrid search trigger is clicked', () => {
    const onSearchExpandedChange = vi.fn();
    render(<SearchModeBar {...createProps({ onSearchExpandedChange })} />);

    fireEvent.click(screen.getByRole('button', { name: /hybrid search/i }));

    expect(onSearchExpandedChange).toHaveBeenCalledWith(true);
  });

  it('renders hybrid search input when expanded', () => {
    render(<SearchModeBar {...createProps({ isSearchExpanded: true })} />);

    expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Query' })).toBeInTheDocument();
  });

  it('calls onSemanticQueryChange when typing in search input', () => {
    const onSemanticQueryChange = vi.fn();
    render(<SearchModeBar {...createProps({ isSearchExpanded: true, onSemanticQueryChange })} />);

    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'test query' } });

    expect(onSemanticQueryChange).toHaveBeenCalledWith('test query');
  });

  it('shows clear button when query is not empty', () => {
    render(<SearchModeBar {...createProps({ isSearchExpanded: true, semanticQuery: 'test' })} />);

    expect(screen.getByRole('button', { name: 'Clear query' })).toBeInTheDocument();
  });

  it('does not show clear button when query is empty', () => {
    render(<SearchModeBar {...createProps({ isSearchExpanded: true, semanticQuery: '' })} />);

    expect(screen.queryByRole('button', { name: 'Clear query' })).not.toBeInTheDocument();
  });

  it('clears query when clear button is clicked', () => {
    const onSemanticQueryChange = vi.fn();
    render(
      <SearchModeBar
        {...createProps({ isSearchExpanded: true, semanticQuery: 'test', onSemanticQueryChange })}
      />
    );

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
          isSearchExpanded: true,
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
          isSearchExpanded: true,
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
    render(<SearchModeBar {...createProps({ isSearchExpanded: true, semanticQuery: '' })} />);

    expect(screen.getByRole('button', { name: 'Query' })).toBeDisabled();
  });

  it('disables search button when searching', () => {
    render(
      <SearchModeBar
        {...createProps({ isSearchExpanded: true, semanticQuery: 'test', isSearching: true })}
      />
    );

    // Button should be disabled but text might be different (Query) or just disabled state
    expect(screen.getByRole('button', { name: 'Query' })).toBeDisabled();
  });

  it('calls onSemanticSearch when search button is clicked', () => {
    const onSemanticSearch = vi.fn();
    render(
      <SearchModeBar
        {...createProps({ isSearchExpanded: true, semanticQuery: 'test', onSemanticSearch })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Query' }));

    expect(onSemanticSearch).toHaveBeenCalled();
  });

  it('triggers search on Cmd/Ctrl+Enter', () => {
    const onSemanticSearch = vi.fn();
    render(
      <SearchModeBar
        {...createProps({ isSearchExpanded: true, semanticQuery: 'test', onSemanticSearch })}
      />
    );

    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    expect(onSemanticSearch).toHaveBeenCalled();
  });

  it('blurs input on Escape key', () => {
    render(<SearchModeBar {...createProps({ isSearchExpanded: true })} />);

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

  it('renders advanced options inside the expanded hybrid search panel', () => {
    render(
      <SearchModeBar
        {...createProps({
          advancedOptions: <div data-testid="advanced-options-slot">Advanced nested panel</div>,
          isSearchExpanded: true,
        })}
      />
    );

    const panel = screen.getByTestId('hybrid-search-panel');
    expect(panel).toContainElement(screen.getByTestId('advanced-options-slot'));
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
          {...createProps({
            isSearchExpanded: true,
            semanticQuery: 'a very long query that\ncould span\nmultiple lines',
          })}
        />
      );

      const textarea = screen.getByRole('textbox', { name: 'Hybrid search query' });
      // With maxRows=6 (before fix): calculatedMaxHeight = 120px → height = 120px
      // With maxRows=1 (after fix):  calculatedMaxHeight = 36px  → height = 36px
      const height = Number.parseInt((textarea as HTMLTextAreaElement).style.height, 10);
      expect(height).toBeLessThanOrEqual(36);
    });
  });
});
