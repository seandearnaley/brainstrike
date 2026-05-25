import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
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

  it('pluralizes the hybrid search result count', () => {
    const { rerender } = render(
      <SearchModeBar {...createProps({ hasSearched: true, resultCount: 1 })} />
    );

    // Result label appears twice: as visible text inside the trigger, and
    // as a sr-only live region sibling that screen readers announce.
    expect(screen.getAllByText('1 result')).toHaveLength(2);

    rerender(<SearchModeBar {...createProps({ hasSearched: true, resultCount: 2 })} />);

    expect(screen.getAllByText('2 results')).toHaveLength(2);
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

  it('renders the query input and action as a compact input button group', () => {
    render(<SearchModeBar {...createProps({ isSearchExpanded: true, semanticQuery: 'search' })} />);

    const inputGroup = screen.getByTestId('hybrid-search-input-group');
    expect(inputGroup).toContainElement(
      screen.getByRole('textbox', { name: 'Hybrid search query' })
    );
    expect(inputGroup).toContainElement(screen.getByRole('button', { name: 'Query' }));
    expect(inputGroup).toHaveClass('flex');
    expect(inputGroup).not.toHaveTextContent(/semantic search across embedded chunks/i);
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

  describe('single-line constraint for semantic query input', () => {
    it('uses a fixed-height input for long natural-language queries', () => {
      render(
        <SearchModeBar
          {...createProps({
            isSearchExpanded: true,
            semanticQuery: 'a very long query that\ncould span\nmultiple lines',
          })}
        />
      );

      expect(screen.getByRole('textbox', { name: 'Hybrid search query' })).toHaveClass('h-9');
    });
  });

  describe('accessibility polish (BST-519)', () => {
    it('hides decorative icons from assistive tech when collapsed', () => {
      const { container } = render(<SearchModeBar {...createProps()} />);

      // Sparkles (leading) and ChevronDown (trailing) are purely decorative;
      // aria-expanded already conveys state, so screen readers should not
      // announce the SVG presentation.
      const sparkles = container.querySelector('.lucide-sparkles');
      const chevronDown = container.querySelector('.lucide-chevron-down');
      expect(sparkles).toHaveAttribute('aria-hidden', 'true');
      expect(chevronDown).toHaveAttribute('aria-hidden', 'true');
    });

    it('hides the expanded-state chevron from assistive tech', () => {
      const { container } = render(<SearchModeBar {...createProps({ isSearchExpanded: true })} />);

      const chevronUp = container.querySelector('.lucide-chevron-up');
      expect(chevronUp).toHaveAttribute('aria-hidden', 'true');
    });

    it('hides the clear-query X icon from assistive tech (button has its own label)', () => {
      const { container } = render(
        <SearchModeBar {...createProps({ isSearchExpanded: true, semanticQuery: 'test' })} />
      );

      const xIcon = container.querySelector('.lucide-x');
      expect(xIcon).toHaveAttribute('aria-hidden', 'true');
    });

    it('hides the searching spinner icon from assistive tech', () => {
      const { container } = render(
        <SearchModeBar
          {...createProps({
            isSearchExpanded: true,
            isSearching: true,
            semanticQuery: 'test',
          })}
        />
      );

      const loader = container.querySelector(
        '.lucide-loader-circle, .lucide-loader2, .lucide-loader-2'
      );
      // Named assertion so a future lucide rename surfaces "expected one of …"
      // instead of a confusing "received null".
      expect(
        loader,
        'Expected one of: .lucide-loader-circle, .lucide-loader2, .lucide-loader-2'
      ).not.toBeNull();
      expect(loader).toHaveAttribute('aria-hidden', 'true');
    });

    it('announces the result count via a polite live region', () => {
      render(<SearchModeBar {...createProps({ hasSearched: true, resultCount: 3 })} />);

      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('3 results');
      expect(status).toHaveAttribute('aria-live', 'polite');
    });

    it('renders an empty live region before any search so older AT can attach to it', () => {
      // Older NVDA/JAWS may only announce mutations on live regions that
      // existed at load time, so the container is always rendered (empty)
      // and gets populated when results arrive.
      render(<SearchModeBar {...createProps()} />);

      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('');
      expect(status).toHaveAttribute('aria-live', 'polite');
    });

    it('collapses the expanded panel when Escape is pressed within it', () => {
      const onSearchExpandedChange = vi.fn();
      render(
        <SearchModeBar {...createProps({ isSearchExpanded: true, onSearchExpandedChange })} />
      );

      const panel = screen.getByTestId('hybrid-search-panel');
      fireEvent.keyDown(panel, { key: 'Escape' });

      expect(onSearchExpandedChange).toHaveBeenCalledWith(false);
    });

    it('does not collapse the panel when Escape originates from the query input', () => {
      // Escape on the input should blur it (existing behavior), not collapse the panel,
      // because users typically want to dismiss the keyboard focus first.
      const onSearchExpandedChange = vi.fn();
      render(
        <SearchModeBar {...createProps({ isSearchExpanded: true, onSearchExpandedChange })} />
      );

      const input = screen.getByRole('textbox', { name: 'Hybrid search query' });
      input.focus();
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(onSearchExpandedChange).not.toHaveBeenCalled();
    });

    it('returns focus to the trigger after Escape collapses the panel', () => {
      // When focus is on a non-input control inside the panel (e.g. Query
      // button) and Escape removes the panel from the DOM, focus would
      // otherwise fall to <body>. Returning focus to the trigger keeps the
      // keyboard user oriented.
      function TestHarness() {
        const [expanded, setExpanded] = React.useState(true);
        return (
          <SearchModeBar
            {...createProps({
              isSearchExpanded: expanded,
              onSearchExpandedChange: setExpanded,
              // Non-empty query so the Query button is focusable (not disabled).
              semanticQuery: 'cat',
            })}
          />
        );
      }
      render(<TestHarness />);

      const trigger = screen.getByRole('button', { name: /hybrid search/i });
      const queryButton = screen.getByRole('button', { name: 'Query' });
      queryButton.focus();
      expect(document.activeElement).toBe(queryButton);

      fireEvent.keyDown(queryButton, { key: 'Escape' });

      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(document.activeElement).toBe(trigger);
    });

    it('renders the result-count live region as a sibling of the trigger, not nested inside it', () => {
      // Live regions nested inside <button> can be unreliably announced by
      // screen readers because button descendants are exposed as
      // presentational. Keeping the status as a sibling fixes that.
      render(<SearchModeBar {...createProps({ hasSearched: true, resultCount: 5 })} />);

      const status = screen.getByRole('status');
      expect(status.closest('button')).toBeNull();
    });
  });
});
