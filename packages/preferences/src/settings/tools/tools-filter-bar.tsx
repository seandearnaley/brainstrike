/**
 * Tools Filter Bar
 *
 * Compact search and filter controls for the tools list.
 */

import {
  TOOL_CATEGORIES,
  TOOL_LOADING_TIERS,
  type ToolCategoryInfo,
  type ToolLoadingTierInfo,
} from '@brainstrike/assistant-contract/tool-metadata';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { RotateCcw, Search } from 'lucide-react';
import type { ToolsFilterBarProps } from './types';

/**
 * Tools Filter Bar Component
 */
export function ToolsFilterBar({
  searchQuery,
  onSearchChange,
  categoryFilter,
  onCategoryChange,
  tierFilter,
  onTierChange,
  onReset,
  totalCount,
}: ToolsFilterBarProps) {
  const hasFilters = searchQuery !== '' || categoryFilter !== 'all' || tierFilter !== 'all';

  return (
    <div
      className="rounded-lg border border-border/50 bg-muted/30 p-2"
      data-testid="tools-filter-bar"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 max-w-xs pl-8"
            data-testid="search-input"
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search tools..."
            type="text"
            value={searchQuery}
          />
        </div>

        <Select
          onValueChange={(value) => onCategoryChange(value as typeof categoryFilter)}
          value={categoryFilter}
        >
          <SelectTrigger className="h-9 w-[140px]" data-testid="category-filter">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {(Object.values(TOOL_CATEGORIES) as ToolCategoryInfo[]).map((cat) => (
              <SelectItem key={cat.id} value={cat.id}>
                {cat.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          onValueChange={(value) => onTierChange(value as typeof tierFilter)}
          value={tierFilter}
        >
          <SelectTrigger className="h-9 w-[140px]" data-testid="tier-filter">
            <SelectValue placeholder="Tier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Tiers</SelectItem>
            {(Object.values(TOOL_LOADING_TIERS) as ToolLoadingTierInfo[]).map((tier) => (
              <SelectItem key={tier.id} value={tier.id}>
                {tier.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Reset filters"
              className="h-9 w-9"
              data-testid="reset-filters"
              disabled={!hasFilters}
              onClick={onReset}
              size="icon"
              variant="outline"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset filters</TooltipContent>
        </Tooltip>

        {totalCount !== undefined && (
          <span className="ml-auto text-muted-foreground text-sm" data-testid="tool-count">
            {totalCount} tools
          </span>
        )}
      </div>
    </div>
  );
}

export default ToolsFilterBar;
