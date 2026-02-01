/**
 * Tools Filter Bar
 *
 * Search and filter controls for the tools list.
 */

import { TOOL_CATEGORIES, TOOL_LOADING_TIERS } from '@brainstrike/agent/client';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
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
}: ToolsFilterBarProps) {
  return (
    <div className="flex flex-wrap gap-2" data-testid="tools-filter-bar">
      <Input
        className="h-9 max-w-xs"
        data-testid="search-input"
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search tools..."
        type="text"
        value={searchQuery}
      />

      <Select
        onValueChange={(value) => onCategoryChange(value as typeof categoryFilter)}
        value={categoryFilter}
      >
        <SelectTrigger className="h-9 w-[140px]" data-testid="category-filter">
          <SelectValue placeholder="Category" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Categories</SelectItem>
          {Object.values(TOOL_CATEGORIES).map((cat) => (
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
          {Object.values(TOOL_LOADING_TIERS).map((tier) => (
            <SelectItem key={tier.id} value={tier.id}>
              {tier.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button data-testid="reset-filters" onClick={onReset} size="sm" variant="outline">
        Reset
      </Button>
    </div>
  );
}

export default ToolsFilterBar;
