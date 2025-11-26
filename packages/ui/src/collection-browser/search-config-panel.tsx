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
    <div className={cn('border-t border-border', className)}>
      {/* Toggle button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={handleToggle}
        className="w-full justify-between px-3 py-2 h-auto hover:bg-muted/50"
        aria-expanded={isExpanded}
        aria-controls="search-config-content"
      >
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
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
        id="search-config-content"
        className={cn(
          'overflow-hidden transition-all duration-200 ease-out',
          isExpanded ? 'max-h-64 opacity-100' : 'max-h-0 opacity-0'
        )}
      >
        <div className="space-y-4 p-3 pt-2">
          {/* Threshold slider */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="threshold" className="text-xs">
                Similarity Threshold
              </Label>
              <span className="text-xs text-muted-foreground font-mono">
                {config.threshold.toFixed(2)}
              </span>
            </div>
            <input
              id="threshold"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={config.threshold}
              onChange={handleThresholdChange}
              className="w-full h-2 bg-muted rounded-lg cursor-pointer accent-primary"
              aria-label="Similarity threshold"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Broad</span>
              <span>Precise</span>
            </div>
          </div>

          {/* Result limit */}
          <div className="space-y-2">
            <Label htmlFor="limit" className="text-xs">
              Max Results
            </Label>
            <Select value={String(config.resultLimit)} onValueChange={handleLimitChange}>
              <SelectTrigger id="limit" className="h-8 text-xs">
                <SelectValue placeholder="Select limit" />
              </SelectTrigger>
              <SelectContent>
                {RESULT_LIMITS.map((limit) => (
                  <SelectItem key={limit} value={String(limit)} className="text-xs">
                    {limit} results
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Distance metric */}
          <div className="space-y-2">
            <Label htmlFor="metric" className="text-xs">
              Distance Metric
              {collectionDistanceMetric && collectionDistanceMetric !== config.distanceMetric && (
                <span className="ml-1 text-amber-500">
                  (collection uses {collectionDistanceMetric})
                </span>
              )}
            </Label>
            <Select value={config.distanceMetric} onValueChange={handleMetricChange}>
              <SelectTrigger id="metric" className="h-8 text-xs">
                <SelectValue placeholder="Select metric" />
              </SelectTrigger>
              <SelectContent>
                {DISTANCE_METRICS.map((metric) => (
                  <SelectItem key={metric.value} value={metric.value} className="text-xs">
                    <div className="flex flex-col">
                      <span>{metric.label}</span>
                      <span className="text-xs text-muted-foreground">{metric.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
});

SearchConfigPanel.displayName = 'SearchConfigPanel';

export default SearchConfigPanel;
