/**
 * SearchConfigPanel Component
 *
 * Collapsible panel for configuring semantic search parameters:
 * - Retrieval mode (vector-only or hybrid with RRF fusion)
 * - Weight sliders for vector/FTS balance (hybrid mode only)
 * - Similarity threshold (0.0-1.0)
 * - Result limit (5, 10, 20, 50, 100)
 * - Distance metric (cosine, L2, inner product)
 */

import { ChevronDown, ChevronUp, Settings, Sparkles, Zap } from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import { Label } from '../label';
import { cn } from '../lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import type { DistanceMetric, RetrievalMode, SearchConfigPanelProps } from './types';

/**
 * Distance metric options with display labels
 */
const DISTANCE_METRICS: Array<{ value: DistanceMetric; label: string; description: string }> = [
  { value: 'cosine', label: 'Cosine', description: 'Best for normalized embeddings' },
  { value: 'l2', label: 'Euclidean (L2)', description: 'Geometric distance' },
  { value: 'ip', label: 'Inner Product', description: 'Dot product similarity' },
];

/**
 * Result limit options
 */
const RESULT_LIMITS = [5, 10, 20, 50, 100];

/**
 * Retrieval mode options with descriptions
 */
const RETRIEVAL_MODES: Array<{
  value: RetrievalMode;
  label: string;
  description: string;
  icon: 'Zap' | 'Sparkles';
}> = [
  { value: 'vector', label: 'Vector', description: 'Fast semantic similarity', icon: 'Zap' },
  {
    value: 'hybrid',
    label: 'Hybrid',
    description: 'Vector + keyword fusion',
    icon: 'Sparkles',
  },
];

/**
 * SearchConfigPanel - Collapsible advanced search options
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

  // Current retrieval mode (default to 'vector')
  const retrievalMode = config.retrievalMode ?? 'vector';
  const isHybridMode = retrievalMode === 'hybrid';

  return (
    <div className={cn('border-border border-t', className)}>
      {/* Toggle button */}
      <Button
        aria-controls="search-config-content"
        aria-expanded={isExpanded}
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

      {/* Collapsible content */}
      <div
        className={cn(
          'overflow-hidden transition-all duration-200 ease-out',
          isExpanded ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'
        )}
        id="search-config-content"
      >
        <div className="space-y-3 p-3 pt-1.5">
          {/* Retrieval Mode Toggle */}
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">
              Retrieval Mode
            </Label>
            <div className="flex gap-1.5">
              {RETRIEVAL_MODES.map((mode) => {
                const Icon = mode.icon === 'Zap' ? Zap : Sparkles;
                const isActive = retrievalMode === mode.value;
                return (
                  <button
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] transition-all',
                      isActive
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    )}
                    key={mode.value}
                    onClick={() => handleRetrievalModeChange(mode.value)}
                    title={mode.description}
                    type="button"
                  >
                    <Icon className="h-3 w-3" />
                    {mode.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Hybrid Mode Weight Sliders (only shown in hybrid mode) */}
          {isHybridMode && (
            <div className="space-y-2 rounded-md bg-muted/30 p-2">
              <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Result Weighting
              </Label>
              <div className="grid grid-cols-2 gap-3">
                {/* Vector weight */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Zap className="h-2.5 w-2.5" />
                      Semantic
                    </span>
                    <span className="font-mono text-[10px] text-primary">
                      {(config.vectorWeight ?? 1.0).toFixed(1)}
                    </span>
                  </div>
                  <input
                    aria-label="Vector search weight"
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary transition-all hover:bg-muted/80"
                    max="2"
                    min="0"
                    onChange={handleVectorWeightChange}
                    step="0.1"
                    type="range"
                    value={config.vectorWeight ?? 1.0}
                  />
                </div>
                {/* FTS weight */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Sparkles className="h-2.5 w-2.5" />
                      Keyword
                    </span>
                    <span className="font-mono text-[10px] text-primary">
                      {(config.ftsWeight ?? 1.0).toFixed(1)}
                    </span>
                  </div>
                  <input
                    aria-label="Full-text search weight"
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary transition-all hover:bg-muted/80"
                    max="2"
                    min="0"
                    onChange={handleFtsWeightChange}
                    step="0.1"
                    type="range"
                    value={config.ftsWeight ?? 1.0}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Threshold slider */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label
                className="text-[10px] text-muted-foreground uppercase tracking-wider"
                htmlFor="threshold"
              >
                Similarity Threshold
              </Label>
              <span className="font-mono text-[10px] text-primary">
                {config.threshold.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-muted-foreground/50 uppercase">Broad</span>
              <input
                aria-label="Similarity threshold"
                className="h-1.5 flex-1 cursor-pointer appearance-none rounded-lg bg-muted accent-primary transition-all hover:bg-muted/80"
                id="threshold"
                max="1"
                min="0"
                onChange={handleThresholdChange}
                step="0.05"
                type="range"
                value={config.threshold}
              />
              <span className="text-[9px] text-muted-foreground/50 uppercase">Precise</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Result limit */}
            <div className="space-y-1">
              <Label
                className="text-[10px] text-muted-foreground uppercase tracking-wider"
                htmlFor="limit"
              >
                Max Results
              </Label>
              <Select onValueChange={handleLimitChange} value={String(config.resultLimit)}>
                <SelectTrigger className="h-7 text-[11px]" id="limit">
                  <SelectValue placeholder="Limit" />
                </SelectTrigger>
                <SelectContent>
                  {RESULT_LIMITS.map((limit) => (
                    <SelectItem className="text-[11px]" key={limit} value={String(limit)}>
                      {limit} results
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Distance metric */}
            <div className="space-y-1">
              <Label
                className="text-[10px] text-muted-foreground uppercase tracking-wider"
                htmlFor="metric"
              >
                Distance Metric
                {collectionDistanceMetric && collectionDistanceMetric !== config.distanceMetric && (
                  <span className="ml-1 text-amber-500/80 lowercase">
                    ({collectionDistanceMetric})
                  </span>
                )}
              </Label>
              <Select onValueChange={handleMetricChange} value={config.distanceMetric}>
                <SelectTrigger className="h-7 text-[11px]" id="metric">
                  <SelectValue placeholder="Metric" />
                </SelectTrigger>
                <SelectContent>
                  {DISTANCE_METRICS.map((metric) => (
                    <SelectItem className="text-[11px]" key={metric.value} value={metric.value}>
                      <div className="flex flex-col">
                        <span>{metric.label}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {metric.description}
                        </span>
                      </div>
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
