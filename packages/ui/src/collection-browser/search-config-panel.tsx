/**
 * SearchConfigPanel Component
 *
 * Compact collapsible panel for configuring semantic search parameters:
 * - Retrieval mode (vector-only or hybrid with RRF fusion)
 * - Weight sliders for vector/FTS balance (hybrid mode only)
 * - Similarity threshold (0.0-1.0)
 * - Result limit (5, 10, 20, 50, 100)
 * - Distance metric (cosine, L2, inner product)
 */

import { ChevronDown, ChevronUp, Settings, Sparkles, Zap } from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import { cn } from '../lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
import type { DistanceMetric, RetrievalMode, SearchConfigPanelProps } from './types';

/**
 * Distance metric options - single line with tooltip for description
 */
const DISTANCE_METRICS: Array<{ value: DistanceMetric; label: string; tooltip: string }> = [
  { value: 'cosine', label: 'Cosine', tooltip: 'Best for normalized embeddings' },
  { value: 'l2', label: 'Euclidean (L2)', tooltip: 'Geometric distance' },
  { value: 'ip', label: 'Inner Product', tooltip: 'Dot product similarity' },
];

/**
 * Result limit options
 */
const RESULT_LIMITS = [5, 10, 20, 50, 100];

/**
 * Retrieval mode options
 */
const RETRIEVAL_MODES: Array<{
  value: RetrievalMode;
  label: string;
  tooltip: string;
  icon: 'Zap' | 'Sparkles';
}> = [
  { value: 'vector', label: 'Vector', tooltip: 'Fast semantic similarity search', icon: 'Zap' },
  {
    value: 'hybrid',
    label: 'Hybrid',
    tooltip: 'Combines vector similarity with keyword matching',
    icon: 'Sparkles',
  },
];

/**
 * SearchConfigPanel - Compact collapsible advanced search options
 */
export const SearchConfigPanel = React.memo(function SearchConfigPanel({
  config,
  onConfigChange,
  isExpanded,
  onExpandedChange,
  collectionDistanceMetric,
  className,
}: SearchConfigPanelProps) {
  // Handle threshold change
  const handleThresholdChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseFloat(e.target.value);
      if (!Number.isNaN(value)) {
        onConfigChange({ ...config, threshold: value });
      }
    },
    [config, onConfigChange]
  );

  // Handle limit change
  const handleLimitChange = React.useCallback(
    (value: string) => {
      const limit = Number.parseInt(value, 10);
      if (!Number.isNaN(limit)) {
        onConfigChange({ ...config, resultLimit: limit });
      }
    },
    [config, onConfigChange]
  );

  // Handle distance metric change
  const handleMetricChange = React.useCallback(
    (value: string) => {
      onConfigChange({ ...config, distanceMetric: value as DistanceMetric });
    },
    [config, onConfigChange]
  );

  // Toggle expanded state
  const handleToggle = React.useCallback(() => {
    onExpandedChange(!isExpanded);
  }, [isExpanded, onExpandedChange]);

  // Handle retrieval mode change
  const handleRetrievalModeChange = React.useCallback(
    (value: string) => {
      onConfigChange({ ...config, retrievalMode: value as RetrievalMode });
    },
    [config, onConfigChange]
  );

  // Handle vector weight change
  const handleVectorWeightChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseFloat(e.target.value);
      if (!Number.isNaN(value)) {
        onConfigChange({ ...config, vectorWeight: value });
      }
    },
    [config, onConfigChange]
  );

  // Handle FTS weight change
  const handleFtsWeightChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseFloat(e.target.value);
      if (!Number.isNaN(value)) {
        onConfigChange({ ...config, ftsWeight: value });
      }
    },
    [config, onConfigChange]
  );

  // Current retrieval mode (default to 'hybrid')
  const retrievalMode = config.retrievalMode ?? 'hybrid';
  const isHybridMode = retrievalMode === 'hybrid';

  // Check if collection metric differs from selected
  const metricMismatch =
    collectionDistanceMetric && collectionDistanceMetric !== config.distanceMetric;

  return (
    <div className={cn('border-border border-t', className)}>
      {/* Toggle button */}
      <Button
        aria-controls="search-config-content"
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} advanced options`}
        className="h-auto w-full justify-between px-3 py-2 hover:bg-muted/50"
        depress={false}
        onClick={handleToggle}
        size="sm"
        variant="ghost"
      >
        <span className="flex items-center gap-2 text-muted-foreground text-xs">
          <Settings className="h-3 w-3" />
          Advanced Options
        </span>
        {isExpanded ? (
          <ChevronUp className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        )}
      </Button>

      {/* Collapsible content - compact layout */}
      <div
        className={cn(
          'overflow-hidden transition-all duration-200 ease-out motion-reduce:transition-none',
          isExpanded ? 'max-h-64 opacity-100' : 'max-h-0 opacity-0'
        )}
        hidden={!isExpanded}
        id="search-config-content"
      >
        <div className="space-y-2 p-3 pt-1.5">
          {/* Row 1: Retrieval Mode Toggle */}
          <div className="flex items-center gap-2">
            <span className="min-w-[52px] text-[10px] text-muted-foreground">Mode</span>
            <fieldset className="flex min-w-0 flex-1 gap-1 border-0 p-0">
              <legend className="sr-only">Retrieval mode</legend>
              {RETRIEVAL_MODES.map((mode) => {
                const Icon = mode.icon === 'Zap' ? Zap : Sparkles;
                const isActive = retrievalMode === mode.value;
                return (
                  <Tooltip key={mode.value}>
                    <TooltipTrigger asChild>
                      <button
                        aria-pressed={isActive}
                        className={cn(
                          'flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] transition-all',
                          isActive
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground hover:bg-muted/80'
                        )}
                        onClick={() => handleRetrievalModeChange(mode.value)}
                        type="button"
                      >
                        <Icon className="h-3 w-3" />
                        {mode.label}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p className="text-xs">{mode.tooltip}</p>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </fieldset>
          </div>

          {/* Row 2: Hybrid Mode Weight Sliders (only shown in hybrid mode) */}
          {isHybridMode && (
            <div className="flex items-center gap-3 rounded-md bg-muted/30 px-2 py-1.5">
              {/* Vector weight */}
              <div className="flex flex-1 items-center gap-2">
                <Zap className="h-3 w-3 text-muted-foreground" />
                <input
                  aria-label="Semantic search weight"
                  className="h-1 flex-1 cursor-pointer appearance-none rounded-lg bg-muted accent-primary"
                  max="2"
                  min="0"
                  onChange={handleVectorWeightChange}
                  step="0.1"
                  title={`Semantic: ${(config.vectorWeight ?? 1.0).toFixed(1)}`}
                  type="range"
                  value={config.vectorWeight ?? 1.0}
                />
                <span className="w-6 font-mono text-[10px] text-primary">
                  {(config.vectorWeight ?? 1.0).toFixed(1)}
                </span>
              </div>
              {/* FTS weight */}
              <div className="flex flex-1 items-center gap-2">
                <Sparkles className="h-3 w-3 text-muted-foreground" />
                <input
                  aria-label="Keyword search weight"
                  className="h-1 flex-1 cursor-pointer appearance-none rounded-lg bg-muted accent-primary"
                  max="2"
                  min="0"
                  onChange={handleFtsWeightChange}
                  step="0.1"
                  title={`Keyword: ${(config.ftsWeight ?? 1.0).toFixed(1)}`}
                  type="range"
                  value={config.ftsWeight ?? 1.0}
                />
                <span className="w-6 font-mono text-[10px] text-primary">
                  {(config.ftsWeight ?? 1.0).toFixed(1)}
                </span>
              </div>
            </div>
          )}

          {/* Row 3: Threshold slider - inline */}
          <div className="flex items-center gap-2">
            <label className="min-w-[52px] text-[10px] text-muted-foreground" htmlFor="threshold">
              Threshold
            </label>
            <input
              className="h-1 flex-1 cursor-pointer appearance-none rounded-lg bg-muted accent-primary"
              id="threshold"
              max="1"
              min="0"
              onChange={handleThresholdChange}
              step="0.05"
              type="range"
              value={config.threshold}
            />
            <span className="w-8 font-mono text-[10px] text-primary">
              {config.threshold.toFixed(2)}
            </span>
          </div>

          {/* Row 4: Max Results & Distance Metric - inline with dropdowns */}
          <div className="flex items-center gap-3">
            {/* Max Results */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">Results</span>
              <Select onValueChange={handleLimitChange} value={String(config.resultLimit)}>
                <SelectTrigger className="h-6 w-16 text-[11px]" id="limit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESULT_LIMITS.map((limit) => (
                    <SelectItem className="text-[11px]" key={limit} value={String(limit)}>
                      {limit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Distance Metric */}
            <div className="flex flex-1 items-center gap-2">
              <span className="text-[10px] text-muted-foreground">
                Metric
                {metricMismatch && (
                  <span
                    className="ml-1 text-amber-500"
                    title={`Collection uses ${collectionDistanceMetric}`}
                  >
                    ⚠
                  </span>
                )}
              </span>
              <Select onValueChange={handleMetricChange} value={config.distanceMetric}>
                <SelectTrigger className="h-6 flex-1 text-[11px]" id="metric">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DISTANCE_METRICS.map((metric) => (
                    <SelectItem
                      className="text-[11px]"
                      key={metric.value}
                      title={metric.tooltip}
                      value={metric.value}
                    >
                      {metric.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

SearchConfigPanel.displayName = 'SearchConfigPanel';

export default SearchConfigPanel;
