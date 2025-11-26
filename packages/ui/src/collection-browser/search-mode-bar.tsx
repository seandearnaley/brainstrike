/**
 * SearchModeBar Component
 *
 * Mode toggle and search input container for the Collection Browser.
 * Provides explicit switching between Quick Filter and Semantic Search modes.
 */

import { ChevronDown, ChevronUp, Filter, Loader2, Search, Sparkles, X } from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import { ExpandableTextarea } from '../expandable-textarea';
import { cn } from '../lib/utils';
import { SearchConfigPanel } from './search-config-panel';
import type { SearchMode, SearchModeBarProps } from './types';

/**
 * Mode toggle tabs configuration
 */
const MODE_TABS: Array<{ mode: SearchMode; label: string; icon: React.ReactNode }> = [
  { mode: 'quick', label: 'Quick Filter', icon: <Filter className="h-3 w-3" /> },
  { mode: 'semantic', label: 'Semantic Search', icon: <Sparkles className="h-3 w-3" /> },
];

/**
 * SearchModeBar - Mode toggle and search input container
 */
export const SearchModeBar = React.memo(function SearchModeBar({
  mode,
  onModeChange,
  semanticQuery,
  onSemanticQueryChange,
  onSemanticSearch,
  isSearching,
  searchConfig,
  onSearchConfigChange,
  isConfigExpanded,
  onConfigExpandedChange,
  resultCount,
  totalCount,
  onExpandAll,
  onCollapseAll,
  hasSearched,
  className,
}: SearchModeBarProps) {
  // Handle semantic query change
  const handleSemanticQueryChange = React.useCallback(
    (value: string) => {
      onSemanticQueryChange(value);
    },
    [onSemanticQueryChange]
  );

  // Handle clear semantic query
  const handleClearSemanticQuery = React.useCallback(() => {
    onSemanticQueryChange('');
  }, [onSemanticQueryChange]);

  // Handle keyboard shortcuts for semantic search
  const handleSemanticKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd/Ctrl + Enter to search
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!isSearching && semanticQuery.trim()) {
          onSemanticSearch();
        }
      }
      // Escape to blur
      if (e.key === 'Escape') {
        e.currentTarget.blur();
      }
    },
    [isSearching, semanticQuery, onSemanticSearch]
  );

  // Handle mode tab click
  const handleModeClick = React.useCallback(
    (newMode: SearchMode) => {
      if (newMode !== mode) {
        onModeChange(newMode);
      }
    },
    [mode, onModeChange]
  );

  return (
    <div className={cn('border-b border-border bg-background', className)}>
      {/* Mode toggle tabs */}
      <div className="flex items-center border-b border-border">
        <div className="flex flex-1" role="tablist" aria-label="Search mode">
          {MODE_TABS.map((tab) => (
            <button
              key={tab.mode}
              role="tab"
              type="button"
              aria-selected={mode === tab.mode}
              aria-controls={`${tab.mode}-search-panel`}
              onClick={() => handleModeClick(tab.mode)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors',
                'border-b-2 -mb-px',
                mode === tab.mode
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/50'
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Expand/Collapse controls (only in quick mode) */}
        {mode === 'quick' && (onExpandAll || onCollapseAll) && (
          <div className="flex items-center gap-1 px-2">
            {onExpandAll && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onExpandAll}
                className="h-6 w-6 p-0"
                title="Expand all"
                aria-label="Expand all nodes"
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
            )}
            {onCollapseAll && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onCollapseAll}
                className="h-6 w-6 p-0"
                title="Collapse all"
                aria-label="Collapse all nodes"
              >
                <ChevronUp className="h-3 w-3" />
              </Button>
            )}
          </div>
        )}

        {/* Result count */}
        {resultCount !== undefined && totalCount !== undefined && (
          <div className="px-3 text-xs text-muted-foreground">
            {mode === 'semantic' && hasSearched
              ? `${resultCount} match${resultCount !== 1 ? 'es' : ''}`
              : `${resultCount} of ${totalCount}`}
          </div>
        )}
      </div>

      {/* Quick Filter mode - no panel needed, CollectionBrowser's FilterBar handles it */}

      {/* Semantic Search Panel */}
      {mode === 'semantic' && (
        <div
          id="semantic-search-panel"
          role="tabpanel"
          aria-labelledby="semantic-tab"
          className="p-2"
        >
          <div className="space-y-2">
            {/* Search input */}
            <div className="relative">
              <ExpandableTextarea
                value={semanticQuery}
                onChange={handleSemanticQueryChange}
                onKeyDown={handleSemanticKeyDown}
                placeholder="Enter semantic search query... (Cmd/Ctrl+Enter to search)"
                minRows={1}
                maxRows={6}
                disabled={isSearching}
                className="pr-8"
                aria-label="Semantic search query"
              />
              {semanticQuery && !isSearching && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClearSemanticQuery}
                  className="absolute right-1 top-2 h-6 w-6 p-0"
                  aria-label="Clear query"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>

            {/* Search button */}
            <div className="flex items-center justify-between">
              <Button
                onClick={onSemanticSearch}
                disabled={isSearching || !semanticQuery.trim()}
                size="sm"
                className="gap-1.5"
              >
                {isSearching ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Searching...
                  </>
                ) : (
                  <>
                    <Search className="h-3 w-3" />
                    Search
                  </>
                )}
              </Button>

              <span className="text-xs text-muted-foreground">Cmd/Ctrl+Enter to search</span>
            </div>
          </div>

          {/* Config panel */}
          <SearchConfigPanel
            config={searchConfig}
            onConfigChange={onSearchConfigChange}
            isExpanded={isConfigExpanded}
            onExpandedChange={onConfigExpandedChange}
            className="mt-2 -mx-2 -mb-2"
          />
        </div>
      )}
    </div>
  );
});

SearchModeBar.displayName = 'SearchModeBar';

export default SearchModeBar;
