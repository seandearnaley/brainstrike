/**
 * SearchConfigPanel Component
 *
 * Pure presentational content for tuning semantic/hybrid search. Designed to sit
 * inside the cog Popover next to the query (open/close is owned by the host):
 * - Retrieval mode (vector-only or hybrid with RRF fusion)
 * - Weight sliders for vector/FTS balance (hybrid mode only)
 * - Similarity threshold (0.0-1.0)
 * - Result limit (free number input, 1–2,000)
 * - Distance metric (cosine, L2, inner product)
 */

import { Sparkles, Zap } from 'lucide-react';
import * as React from 'react';
import { Input } from '../input';
import { cn } from '../lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
import {
  clampResultLimit,
  RESULT_LIMIT_LARGE,
  RESULT_LIMIT_MAX,
  RESULT_LIMIT_MIN,
} from './search-config-bounds';
import type { DistanceMetric, RetrievalMode, SearchConfigPanelProps } from './types';

const DISTANCE_METRICS: Array<{ value: DistanceMetric; label: string; tooltip: string }> = [
  { value: 'cosine', label: 'Cosine', tooltip: 'Best for normalized embeddings' },
  { value: 'l2', label: 'Euclidean (L2)', tooltip: 'Geometric distance' },
  { value: 'ip', label: 'Inner Product', tooltip: 'Dot product similarity' },
];

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

const ROW = 'flex min-w-0 items-center gap-2';
const ROW_LABEL = 'min-w-[56px] shrink-0 text-[10px] text-muted-foreground';
// `min-w-0` is essential: native range inputs report an intrinsic width, so
// without it `flex-1` can't shrink them and they overflow the narrow popover.
const RANGE_INPUT =
  'h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-lg bg-muted accent-primary';
const VALUE_TEXT = 'shrink-0 text-right font-mono text-[10px] text-primary';

/**
 * SearchConfigPanel - pure search-tuning controls (no self-managed accordion).
 */
export const SearchConfigPanel = React.memo(function SearchConfigPanel({
  config,
  onConfigChange,
  collectionDistanceMetric,
  className,
}: SearchConfigPanelProps) {
  const handleThresholdChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseFloat(e.target.value);
      if (!Number.isNaN(value)) {
        onConfigChange({ ...config, threshold: value });
      }
    },
    [config, onConfigChange]
  );

  // Hold the raw string while the field is focused so intermediate states ("",
  // "0", "05") are editable; parse + clamp + commit only on blur/Enter. A
  // controlled input that clamped every keystroke couldn't be cleared or retyped.
  const [limitDraft, setLimitDraft] = React.useState<string | null>(null);

  const handleLimitChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLimitDraft(e.target.value);
  }, []);

  const commitLimit = React.useCallback(() => {
    const raw = (limitDraft ?? '').trim();
    setLimitDraft(null); // revert the display to the (possibly updated) config value
    if (raw === '') {
      return; // empty stays at the previous value — never write NaN
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      return;
    }
    const clamped = clampResultLimit(parsed);
    if (clamped !== config.resultLimit) {
      onConfigChange({ ...config, resultLimit: clamped });
    }
  }, [config, limitDraft, onConfigChange]);

  const handleLimitKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }, []);

  const handleMetricChange = React.useCallback(
    (value: string) => {
      onConfigChange({ ...config, distanceMetric: value as DistanceMetric });
    },
    [config, onConfigChange]
  );

  const handleRetrievalModeChange = React.useCallback(
    (value: RetrievalMode) => {
      onConfigChange({ ...config, retrievalMode: value });
    },
    [config, onConfigChange]
  );

  const handleVectorWeightChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseFloat(e.target.value);
      if (!Number.isNaN(value)) {
        onConfigChange({ ...config, vectorWeight: value });
      }
    },
    [config, onConfigChange]
  );

  const handleFtsWeightChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseFloat(e.target.value);
      if (!Number.isNaN(value)) {
        onConfigChange({ ...config, ftsWeight: value });
      }
    },
    [config, onConfigChange]
  );

  const retrievalMode = config.retrievalMode ?? 'hybrid';
  const isHybridMode = retrievalMode === 'hybrid';
  const metricMismatch =
    collectionDistanceMetric && collectionDistanceMetric !== config.distanceMetric;
  const isLargeLimit = config.resultLimit > RESULT_LIMIT_LARGE;

  return (
    <div className={cn('space-y-2.5', className)}>
      {/* Retrieval mode */}
      <div className={ROW}>
        <span className={ROW_LABEL}>Mode</span>
        <fieldset className="flex min-w-0 flex-1 gap-1 border-0 p-0">
          <legend className="sr-only">Retrieval mode</legend>
          {RETRIEVAL_MODES.map((modeOption) => {
            const Icon = modeOption.icon === 'Zap' ? Zap : Sparkles;
            const isActive = retrievalMode === modeOption.value;
            return (
              <Tooltip key={modeOption.value}>
                <TooltipTrigger asChild>
                  <button
                    aria-pressed={isActive}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors',
                      isActive
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    )}
                    onClick={() => handleRetrievalModeChange(modeOption.value)}
                    type="button"
                  >
                    <Icon className="h-3 w-3" />
                    {modeOption.label}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">{modeOption.tooltip}</p>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </fieldset>
      </div>

      {/* Weight sliders (hybrid only). Stacked vertically so each gets the full
          track width — two side-by-side sliders don't fit a narrow popover. */}
      {isHybridMode && (
        <div className="space-y-1.5 rounded-md bg-muted/30 px-2 py-1.5">
          <div className={ROW}>
            <Zap className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="w-14 shrink-0 text-[10px] text-muted-foreground">Semantic</span>
            <input
              aria-label="Semantic search weight"
              className={RANGE_INPUT}
              max="2"
              min="0"
              onChange={handleVectorWeightChange}
              step="0.1"
              type="range"
              value={config.vectorWeight ?? 1.0}
            />
            <span className={cn(VALUE_TEXT, 'w-6')}>{(config.vectorWeight ?? 1.0).toFixed(1)}</span>
          </div>
          <div className={ROW}>
            <Sparkles className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="w-14 shrink-0 text-[10px] text-muted-foreground">Keyword</span>
            <input
              aria-label="Keyword search weight"
              className={RANGE_INPUT}
              max="2"
              min="0"
              onChange={handleFtsWeightChange}
              step="0.1"
              type="range"
              value={config.ftsWeight ?? 1.0}
            />
            <span className={cn(VALUE_TEXT, 'w-6')}>{(config.ftsWeight ?? 1.0).toFixed(1)}</span>
          </div>
        </div>
      )}

      {/* Threshold */}
      <div className={ROW}>
        <label className={ROW_LABEL} htmlFor="threshold">
          Threshold
        </label>
        <input
          className={RANGE_INPUT}
          id="threshold"
          max="1"
          min="0"
          onChange={handleThresholdChange}
          step="0.05"
          type="range"
          value={config.threshold}
        />
        <span className={cn(VALUE_TEXT, 'w-8')}>{config.threshold.toFixed(2)}</span>
      </div>

      {/* Results (free number input) + Metric */}
      <div className="flex items-center gap-3">
        <div className={ROW}>
          <label className="text-[10px] text-muted-foreground" htmlFor="result-limit">
            Results
          </label>
          <Input
            aria-label="Result limit"
            className="h-7 w-20 px-2 text-[11px]"
            id="result-limit"
            max={RESULT_LIMIT_MAX}
            min={RESULT_LIMIT_MIN}
            onBlur={commitLimit}
            onChange={handleLimitChange}
            onKeyDown={handleLimitKeyDown}
            step={1}
            type="number"
            value={limitDraft ?? String(config.resultLimit)}
          />
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-[10px] text-muted-foreground">
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
            <SelectTrigger className="h-7 flex-1 text-[11px]" id="metric">
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

      {isLargeLimit && (
        <p className="text-[10px] text-amber-600 dark:text-amber-400">
          Large result sets rank slower.
        </p>
      )}
    </div>
  );
});

SearchConfigPanel.displayName = 'SearchConfigPanel';

export default SearchConfigPanel;
