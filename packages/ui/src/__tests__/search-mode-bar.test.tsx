import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SearchModeBar } from '../collection-browser/search-mode-bar';
import type { SearchModeBarProps } from '../collection-browser/types';

describe('SearchModeBar', () => {
  const createProps = (overrides: Partial<SearchModeBarProps> = {}): SearchModeBarProps => ({
    hasSearched: false,
    isSearchExpanded: false,
    isSearching: false,
    mode: 'semantic',
    onModeChange: vi.fn(),
    onSearchExpandedChange: vi.fn(),
    onSemanticQueryChange: vi.fn(),
    onSemanticSearch: vi.fn(),
    semanticQuery: '',
    ...overrides,
  });

  const SEARCH_PLACEHOLDER = /Describe what you want to find... \(Cmd\+Enter\)/i;

  it('renders a compact single-line collapsed hybrid search trigger', () => {
    render(<SearchModeBar {...createProps()} />);

    expect(screen.getByRole('button', { name: /expand hybrid search/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.getByText('Hybrid search')).toBeInTheDocument();
    // Compact: the multi-line descriptive subtitle is gone (intent lives in the
    // input placeholder), so the trigger stays a single row.
    expect(screen.queryByText(/semantic similarity with keyword matches/i)).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: /expand hybrid search/i }));

    expect(onSearchExpandedChange).toHaveBeenCalledWith(true);
  });

  it('toggles hybrid search panel with Enter and Space on the trigger', async () => {
    const user = userEvent.setup();
    const onSearchExpandedChange = vi.fn();
    const { rerender } = render(<SearchModeBar {...createProps({ onSearchExpandedChange })} />);

    const expandTrigger = screen.getByRole('button', { name: /expand hybrid search/i });
    expandTrigger.focus();
    await user.keyboard('{Enter}');
    expect(onSearchExpandedChange).toHaveBeenCalledWith(true);

    onSearchExpandedChange.mockClear();
    rerender(
      <SearchModeBar {...createProps({ isSearchExpanded: true, onSearchExpandedChange })} />
    );
    const collapseTrigger = screen.getByRole('button', { name: /collapse hybrid search/i });
    collapseTrigger.focus();
    await user.keyboard(' ');
    expect(onSearchExpandedChange).toHaveBeenCalledWith(false);
  });

  it('binds aria-controls to the rendered panel id when expanded', () => {
    render(<SearchModeBar {...createProps({ isSearchExpanded: true })} />);

    const trigger = screen.getByRole('button', { name: /collapse hybrid search/i });
    const panel = screen.getByTestId('hybrid-search-panel');

    const controlsId = trigger.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    expect(panel.id).toBe(controlsId);
  });

  it('keeps the hybrid-search-panel in the DOM with hidden when collapsed so aria-controls stays valid', () => {
    render(<SearchModeBar {...createProps({ isSearchExpanded: false })} />);

    const trigger = screen.getByRole('button', { name: /expand hybrid search/i });
    const panel = screen.getByTestId('hybrid-search-panel');

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(panel).not.toBeVisible();
    expect(panel.id).toBe(trigger.getAttribute('aria-controls'));
  });

  it('disables Loader2 spin animation under reduced motion', () => {
    render(
      <SearchModeBar
        {...createProps({ isSearchExpanded: true, isSearching: true, semanticQuery: 'test' })}
      />
    );

    const spinner = screen.getByRole('button', { name: 'Query' }).querySelector('svg');
    expect(spinner).toHaveClass('motion-reduce:animate-none');
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
        {...createProps({ isSearchExpanded: true, onSemanticQueryChange, semanticQuery: 'test' })}
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
        {...createProps({ isSearchExpanded: true, isSearching: true, semanticQuery: 'test' })}
      />
    );

    // Button should be disabled but text might be different (Query) or just disabled state
    expect(screen.getByRole('button', { name: 'Query' })).toBeDisabled();
  });

  it('disables the full hybrid search affordance when disabled', () => {
    render(
      <SearchModeBar
        {...createProps({
          disabled: true,
          isSearchExpanded: true,
          semanticQuery: 'test',
        })}
      />
    );

    expect(screen.getByRole('button', { name: /collapse hybrid search/i })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Hybrid search query' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Query' })).toBeDisabled();
  });

  it('calls onSemanticSearch when search button is clicked', () => {
    const onSemanticSearch = vi.fn();
    render(
      <SearchModeBar
        {...createProps({ isSearchExpanded: true, onSemanticSearch, semanticQuery: 'test' })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Query' }));

    expect(onSemanticSearch).toHaveBeenCalled();
  });

  it('triggers search on Cmd/Ctrl+Enter', () => {
    const onSemanticSearch = vi.fn();
    render(
      <SearchModeBar
        {...createProps({ isSearchExpanded: true, onSemanticSearch, semanticQuery: 'test' })}
      />
    );

    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.keyDown(input, { ctrlKey: true, key: 'Enter' });

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

  it('renders a search-options cog in the input row when advancedOptions are provided', () => {
    render(
      <SearchModeBar
        {...createProps({
          advancedOptions: <div data-testid="advanced-options-slot">Advanced nested panel</div>,
          isSearchExpanded: true,
        })}
      />
    );

    const group = screen.getByTestId('hybrid-search-input-group');
    expect(group).toContainElement(screen.getByRole('button', { name: /search options/i }));
  });

  it('keeps advanced options behind the cog (not inline) when the popover is closed', () => {
    render(
      <SearchModeBar
        {...createProps({
          advancedOptions: <div data-testid="advanced-options-slot">Advanced nested panel</div>,
          advancedOptionsOpen: false,
          isSearchExpanded: true,
        })}
      />
    );

    expect(screen.queryByTestId('advanced-options-slot')).not.toBeInTheDocument();
  });

  it('reveals advanced options when the cog popover is open', () => {
    render(
      <SearchModeBar
        {...createProps({
          advancedOptions: <div data-testid="advanced-options-slot">Advanced nested panel</div>,
          advancedOptionsOpen: true,
          isSearchExpanded: true,
        })}
      />
    );

    expect(screen.getByTestId('advanced-options-slot')).toBeInTheDocument();
  });

  it('requests the popover to open when the cog is clicked', () => {
    const onAdvancedOptionsOpenChange = vi.fn();
    render(
      <SearchModeBar
        {...createProps({
          advancedOptions: <div data-testid="advanced-options-slot">Advanced nested panel</div>,
          advancedOptionsOpen: false,
          isSearchExpanded: true,
          onAdvancedOptionsOpenChange,
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /search options/i }));

    expect(onAdvancedOptionsOpenChange).toHaveBeenCalledWith(true);
  });

  it('omits the cog entirely when no advancedOptions are provided', () => {
    render(<SearchModeBar {...createProps({ isSearchExpanded: true })} />);

    expect(screen.queryByRole('button', { name: /search options/i })).not.toBeInTheDocument();
  });

  it('closes the advanced-options popover when the search panel collapses', () => {
    // The popover content portals to document.body, so if the panel collapses
    // while it is open the floating panel would linger over a hidden trigger.
    const onAdvancedOptionsOpenChange = vi.fn();
    const props = {
      advancedOptions: <div data-testid="advanced-options-slot" />,
      advancedOptionsOpen: true,
      onAdvancedOptionsOpenChange,
    };
    const { rerender } = render(
      <SearchModeBar {...createProps({ ...props, isSearchExpanded: true })} />
    );
    expect(onAdvancedOptionsOpenChange).not.toHaveBeenCalled();

    rerender(<SearchModeBar {...createProps({ ...props, isSearchExpanded: false })} />);

    expect(onAdvancedOptionsOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes the cog popover on collapse even in uncontrolled mode (no open props)', () => {
    // Shared @brainstrike/ui consumers may mount the cog without wiring the
    // open-control props. The portaled content must still not linger over the
    // now-hidden trigger when the panel collapses.
    const props = {
      advancedOptions: <div data-testid="advanced-options-slot">Advanced nested panel</div>,
    };
    const { rerender } = render(
      <SearchModeBar {...createProps({ ...props, isSearchExpanded: true })} />
    );

    // Open via the cog — Radix manages the open state internally here.
    fireEvent.click(screen.getByRole('button', { name: /search options/i }));
    expect(screen.getByTestId('advanced-options-slot')).toBeInTheDocument();

    // Collapsing the panel must close the floating popover content.
    rerender(<SearchModeBar {...createProps({ ...props, isSearchExpanded: false })} />);
    expect(screen.queryByTestId('advanced-options-slot')).not.toBeInTheDocument();
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
