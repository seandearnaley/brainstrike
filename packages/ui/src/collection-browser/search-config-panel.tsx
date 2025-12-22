/**
 * SearchConfigPanel Component
 *
 * Collapsible panel for configuring semantic search parameters:
 * - Similarity threshold (0.0-1.0)
 * - Result limit (5, 10, 20, 50, 100)
 * - Distance metric (cosine, L2, inner product)
 */

import { ChevronDown, ChevronUp, Settings } from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import { Label } from '../label';
import { cn } from '../lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import type { DistanceMetric, SearchConfigPanelProps } from './types';

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
          isExpanded ? 'max-h-64 opacity-100' : 'max-h-0 opacity-0'
        )}
        id="search-config-content"
      >
        <div className="space-y-3 p-3 pt-1.5">
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
