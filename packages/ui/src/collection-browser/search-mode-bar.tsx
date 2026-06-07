/**
 * SearchModeBar Component
 *
 * Collapsible hybrid search panel for collection semantic search.
 * Quick filtering and grid controls are handled by sibling toolbar/filter components.
 *
 * Layout is deliberately compact: a single-line trigger, one query row, and the
 * tuning controls tucked behind a cog Popover so they float over content instead
 * of pushing the results tree down.
 */

import { ChevronDown, ChevronUp, Loader2, Settings2, Sparkles, X } from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import { Input } from '../input';
import { cn } from '../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import type { SearchModeBarProps } from './types';

export const SearchModeBar = React.memo(function SearchModeBar({
  mode,
  onModeChange,
  semanticQuery,
  onSemanticQueryChange,
  onSemanticSearch,
  isSearching,
  isSearchExpanded,
  onSearchExpandedChange,
  hasSearched,
  resultCount,
  advancedOptions,
  advancedOptionsOpen,
  onAdvancedOptionsOpenChange,
  className,
  disabled = false,
  disabledReason,
}: SearchModeBarProps) {
  const handleSemanticQueryChange = React.useCallback(
    (value: string) => {
      if (disabled) {
        return;
      }
      onSemanticQueryChange(value);
      if (value.trim() === '' && mode === 'semantic' && hasSearched) {
        onModeChange('quick');
      }
    },
    [disabled, onSemanticQueryChange, mode, hasSearched, onModeChange]
  );

  const handleClearSemanticQuery = React.useCallback(() => {
    if (disabled) {
      return;
    }
    onSemanticQueryChange('');
    if (mode === 'semantic' && hasSearched) {
      onModeChange('quick');
    }
  }, [disabled, onSemanticQueryChange, mode, hasSearched, onModeChange]);

  const handleSemanticInputChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      handleSemanticQueryChange(event.currentTarget.value);
    },
    [handleSemanticQueryChange]
  );

  const handleSemanticKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!(disabled || isSearching) && semanticQuery.trim()) {
          onSemanticSearch();
        }
      }
      if (e.key === 'Escape') {
        // preventDefault marks the event so the panel's document-level
        // collapse handler skips it. Lets us add custom text-input controls
        // later without relying on a tagName check at the listener.
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
    [disabled, isSearching, semanticQuery, onSemanticSearch]
  );

  const handleToggleExpanded = React.useCallback(() => {
    if (disabled) {
      return;
    }
    onSearchExpandedChange(!isSearchExpanded);
  }, [disabled, isSearchExpanded, onSearchExpandedChange]);

  const panelRef = React.useRef<HTMLElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  // useId-suffixed so multiple SearchModeBar instances don't collide.
  const reactId = React.useId();
  const triggerId = `hybrid-search-trigger-${reactId}`;
  const panelId = `hybrid-search-panel-${reactId}`;

  // Escape collapses the panel and restores focus to the trigger. The query
  // input preventDefaults its own Escape (blur first) so defaultPrevented is
  // the primary gate; the tagName check is defense-in-depth.
  React.useEffect(() => {
    if (!isSearchExpanded) {
      return;
    }
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const panel = panelRef.current;
      if (!(panel && target && panel.contains(target))) {
        return;
      }
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return;
      }
      event.preventDefault();
      onSearchExpandedChange(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      document.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [isSearchExpanded, onSearchExpandedChange]);

  // Controllable open-state: when the consumer supplies `advancedOptionsOpen`
  // we mirror it; otherwise we own the state internally. Either way the Popover
  // below is ALWAYS controlled, so the collapse guard works even when a
  // consumer mounts the cog without wiring the open-control props (Radix's own
  // uncontrolled fallback would otherwise leave portaled content floating over
  // the hidden trigger).
  const isPopoverControlled = advancedOptionsOpen !== undefined;
  const [internalOptionsOpen, setInternalOptionsOpen] = React.useState(false);
  const optionsOpen = isPopoverControlled ? advancedOptionsOpen : internalOptionsOpen;
  const setOptionsOpen = React.useCallback(
    (open: boolean) => {
      if (!isPopoverControlled) {
        setInternalOptionsOpen(open);
      }
      onAdvancedOptionsOpenChange?.(open);
    },
    [isPopoverControlled, onAdvancedOptionsOpenChange]
  );

  // The cog Popover portals its content to document.body, so collapsing the
  // panel while it is open would leave the floating options lingering over a
  // hidden trigger. Close it whenever the panel collapses.
  React.useEffect(() => {
    if (!isSearchExpanded && optionsOpen) {
      setOptionsOpen(false);
    }
  }, [isSearchExpanded, optionsOpen, setOptionsOpen]);

  const resultLabel =
    hasSearched && resultCount !== undefined
      ? `${resultCount} result${resultCount === 1 ? '' : 's'}`
      : null;

  return (
    <div className={cn('bg-background', className)}>
      {/* Live region outside the trigger — button descendants are
          presentational in screen readers, so nested live regions
          announce unreliably. Always rendered (with empty content when
          there are no results) so older NVDA/JAWS announce the first
          count change; some engines only track mutations on regions
          that existed at load time. */}
      <span aria-live="polite" className="sr-only" role="status">
        {resultLabel ?? ''}
      </span>
      <Button
        aria-controls={panelId}
        aria-expanded={isSearchExpanded}
        aria-label={`${isSearchExpanded ? 'Collapse' : 'Expand'} hybrid search`}
        className="h-auto w-full justify-between rounded-none px-3 py-1.5 text-left hover:bg-muted/50"
        depress={false}
        disabled={disabled}
        id={triggerId}
        onClick={handleToggleExpanded}
        ref={triggerRef}
        size="sm"
        title={disabled ? disabledReason : undefined}
        variant="ghost"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate font-medium text-sm">Hybrid search</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
          {resultLabel}
          {isSearchExpanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </span>
      </Button>
      {/* Always rendered (with `hidden` when collapsed) so the trigger's
          aria-controls={panelId} always references a real element. */}
      <section
        aria-labelledby={triggerId}
        className="overflow-hidden"
        data-testid="hybrid-search-panel"
        hidden={!isSearchExpanded}
        id={panelId}
        ref={panelRef}
      >
        <div className="px-3 pt-1 pb-3" data-testid="hybrid-search-controls">
          <div className="flex min-w-0 items-stretch gap-1" data-testid="hybrid-search-input-group">
            <div className="relative min-w-0 flex-1">
              <Input
                aria-label="Hybrid search query"
                className="h-9 pr-8 text-xs"
                disabled={disabled || isSearching}
                maxLength={10_000}
                onChange={handleSemanticInputChange}
                onKeyDown={handleSemanticKeyDown}
                placeholder="Describe what you want to find... (Cmd+Enter)"
                title={disabled ? disabledReason : undefined}
                value={semanticQuery}
              />
              {semanticQuery && !(disabled || isSearching) && (
                <Button
                  aria-label="Clear query"
                  className="absolute top-1.5 right-1.5 h-6 w-6 p-0"
                  onClick={handleClearSemanticQuery}
                  size="sm"
                  variant="ghost"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            {advancedOptions != null && (
              <Popover onOpenChange={setOptionsOpen} open={optionsOpen}>
                <PopoverTrigger asChild>
                  <Button
                    aria-label="Search options"
                    className="h-9 w-9 shrink-0 p-0"
                    disabled={disabled}
                    size="sm"
                    title={disabled ? disabledReason : undefined}
                    variant="outline"
                  >
                    <Settings2 className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-3" side="bottom">
                  {advancedOptions}
                </PopoverContent>
              </Popover>
            )}
            <Button
              className="h-9 shrink-0 px-2.5"
              disabled={disabled || isSearching || !semanticQuery.trim()}
              onClick={onSemanticSearch}
              size="sm"
              title={disabled ? disabledReason : undefined}
            >
              {isSearching ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              <span>Query</span>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
});

SearchModeBar.displayName = 'SearchModeBar';

export default SearchModeBar;
