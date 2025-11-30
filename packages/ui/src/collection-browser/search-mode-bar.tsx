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
    <div className={cn('border-border border-b bg-background', className)}>
      {/* Mode toggle tabs */}
      <div className="flex items-center border-border border-b">
        <div aria-label="Search mode" className="flex flex-1" role="tablist">
          {MODE_TABS.map((tab) => (
            <button
              aria-controls={`${tab.mode}-search-panel`}
              aria-selected={mode === tab.mode}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 font-medium text-xs transition-colors',
                '-mb-px border-b-2',
                mode === tab.mode
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground'
              )}
              key={tab.mode}
              onClick={() => handleModeClick(tab.mode)}
              role="tab"
              type="button"
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
                aria-label="Expand all nodes"
                className="h-6 w-6 p-0"
                onClick={onExpandAll}
                size="sm"
                title="Expand all"
                variant="ghost"
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
            )}
            {onCollapseAll && (
              <Button
                aria-label="Collapse all nodes"
                className="h-6 w-6 p-0"
                onClick={onCollapseAll}
                size="sm"
                title="Collapse all"
                variant="ghost"
              >
                <ChevronUp className="h-3 w-3" />
              </Button>
            )}
          </div>
        )}

        {/* Result count */}
        {resultCount !== undefined && totalCount !== undefined && (
          <div className="px-3 text-muted-foreground text-xs">
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
          aria-labelledby="semantic-tab"
          className="p-2"
          id="semantic-search-panel"
          role="tabpanel"
        >
          <div className="space-y-2">
            {/* Search input */}
            <div className="relative">
              <ExpandableTextarea
                aria-label="Semantic search query"
                className="pr-8"
                disabled={isSearching}
                maxRows={6}
                minRows={1}
                onChange={handleSemanticQueryChange}
                onKeyDown={handleSemanticKeyDown}
                placeholder="Enter semantic search query... (Cmd/Ctrl+Enter to search)"
                value={semanticQuery}
              />
              {semanticQuery && !isSearching && (
                <Button
                  aria-label="Clear query"
                  className="absolute top-2 right-1 h-6 w-6 p-0"
                  onClick={handleClearSemanticQuery}
                  size="sm"
                  variant="ghost"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>

            {/* Search button */}
            <div className="flex items-center justify-between">
              <Button
                className="gap-1.5"
                disabled={isSearching || !semanticQuery.trim()}
                onClick={onSemanticSearch}
                size="sm"
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

              <span className="text-muted-foreground text-xs">Cmd/Ctrl+Enter to search</span>
            </div>
          </div>

          {/* Config panel */}
          <SearchConfigPanel
            className="-mx-2 -mb-2 mt-2"
            config={searchConfig}
            isExpanded={isConfigExpanded}
            onConfigChange={onSearchConfigChange}
            onExpandedChange={onConfigExpandedChange}
          />
        </div>
      )}
    </div>
  );
});

SearchModeBar.displayName = 'SearchModeBar';

export default SearchModeBar;
