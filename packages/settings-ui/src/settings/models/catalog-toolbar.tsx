import {
  Badge,
  Button,
  Checkbox,
  cn,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  SlidersHorizontal,
  Sun,
  X,
} from 'lucide-react';
import { type ReactNode, type RefObject, useId } from 'react';
import { SettingsSearchIcon } from '../settings-search-icon';
import { SETTINGS_SEARCH_INPUT_STYLE } from '../settings-search-layout';
import {
  type CatalogContextBand,
  type CatalogFilterChip,
  type CatalogFilterKey,
  type CatalogFilters,
  type CatalogStatusFilter,
  type CatalogTypeFilter,
  CONTEXT_BAND_LABELS,
  CONTEXT_BAND_OPTIONS,
  parseContextBand,
} from './catalog-filters';
import { pluralNoun } from './catalog-format';
import type { CatalogProviderStat, CatalogSummary } from './catalog-sections';

interface SegmentOption<T extends string> {
  readonly label: string;
  readonly value: T;
}

const STATUS_OPTIONS: readonly SegmentOption<CatalogStatusFilter>[] = [
  { label: 'All', value: 'all' },
  { label: 'Enabled', value: 'enabled' },
  { label: 'Disabled', value: 'disabled' },
];

const TYPE_OPTIONS: readonly SegmentOption<CatalogTypeFilter>[] = [
  { label: 'All', value: 'all' },
  { label: 'Chat', value: 'chat' },
  { label: 'Embedding', value: 'embedding' },
];

/** A segmented control built from a native radio group: arrow keys and semantics come free. */
function Segmented<T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  readonly label: string;
  readonly onChange: (next: T) => void;
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
}) {
  const name = useId();
  return (
    <div
      aria-label={label}
      className="inline-flex h-8 shrink-0 items-center rounded-lg border bg-muted/40 p-0.5"
      role="radiogroup"
    >
      {options.map((option) => (
        <label
          className="flex h-full cursor-pointer items-center rounded-md px-2.5 text-muted-foreground text-xs transition-colors has-[:checked]:bg-background has-[:checked]:text-foreground has-[:checked]:shadow-xs has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
          key={option.value}
        >
          <input
            checked={value === option.value}
            className="sr-only"
            name={name}
            onChange={() => onChange(option.value)}
            type="radio"
            value={option.value}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

function ToggleChip({
  icon,
  label,
  onPressedChange,
  pressed,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly onPressedChange: (pressed: boolean) => void;
  readonly pressed: boolean;
}) {
  return (
    <Button
      aria-pressed={pressed}
      className={cn(
        'h-8 gap-1.5 px-3 text-xs',
        pressed && 'border-primary/50 bg-primary/10 text-primary hover:bg-primary/15'
      )}
      onClick={() => onPressedChange(!pressed)}
      size="sm"
      variant="outline"
    >
      {icon}
      {label}
    </Button>
  );
}

function ContextSelect({
  onChange,
  value,
}: {
  readonly onChange: (next: CatalogContextBand) => void;
  readonly value: CatalogContextBand;
}) {
  return (
    <Select onValueChange={(next) => onChange(parseContextBand(next))} value={value}>
      <SelectTrigger
        aria-label="Minimum context window"
        className="w-auto gap-1.5 text-xs"
        data-testid="model-catalog-context-trigger"
        size="sm"
      >
        <span className="text-muted-foreground">Context:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CONTEXT_BAND_OPTIONS.map((band) => (
          <SelectItem key={band} value={band}>
            {CONTEXT_BAND_LABELS[band]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ProvidersList({
  onChange,
  options,
  selected,
}: {
  readonly onChange: (next: ReadonlySet<string>) => void;
  readonly options: readonly CatalogProviderStat[];
  readonly selected: ReadonlySet<string>;
}) {
  const idPrefix = useId();
  const toggle = (providerId: string, checked: boolean): void => {
    const next = new Set(selected);
    if (checked) {
      next.add(providerId);
    } else {
      next.delete(providerId);
    }
    onChange(next);
  };
  return (
    <div className="max-h-72 space-y-0.5 overflow-y-auto">
      {options.map((option) => {
        const checkboxId = `${idPrefix}-${option.providerId}`;
        return (
          <label
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
            htmlFor={checkboxId}
            key={option.providerId}
          >
            <Checkbox
              checked={selected.has(option.providerId)}
              id={checkboxId}
              onCheckedChange={(checked) => toggle(option.providerId, checked === true)}
            />
            <span className="min-w-0 flex-1 truncate">{option.providerName}</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {option.totalCount}
              <span className="sr-only"> {pluralNoun(option.totalCount, 'model')}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function ProvidersPopover({
  onChange,
  options,
  selected,
}: {
  readonly onChange: (next: ReadonlySet<string>) => void;
  readonly options: readonly CatalogProviderStat[];
  readonly selected: ReadonlySet<string>;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className="h-8 gap-1.5 px-3 text-xs"
          data-testid="model-catalog-providers-trigger"
          size="sm"
          variant="outline"
        >
          Providers
          <span className="text-muted-foreground">
            {selected.size === 0 ? 'All' : selected.size}
          </span>
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <ProvidersList onChange={onChange} options={options} selected={selected} />
      </PopoverContent>
    </Popover>
  );
}

function SummaryText({ summary }: { readonly summary: CatalogSummary }) {
  if (!summary.filtering) {
    return (
      <>
        <span className="font-semibold text-foreground">{summary.totalModels}</span>{' '}
        {pluralNoun(summary.totalModels, 'model')} · {summary.totalProviders}{' '}
        {pluralNoun(summary.totalProviders, 'provider')} ·{' '}
        <span className="font-semibold text-foreground">{summary.enabledModels}</span> enabled
      </>
    );
  }
  return (
    <>
      <span className="font-semibold text-foreground">{summary.matchingModels}</span> of{' '}
      {summary.totalModels} {pluralNoun(summary.totalModels, 'model')} match ·{' '}
      {summary.matchingProviders} {pluralNoun(summary.matchingProviders, 'provider')}
    </>
  );
}

export interface CatalogToolbarProps {
  readonly chips: readonly CatalogFilterChip[];
  /** Narrow tier (< 640px catalog width). */
  readonly compact: boolean;
  readonly filters: CatalogFilters;
  readonly onClearAll: () => void;
  readonly onClearChip: (key: CatalogFilterKey) => void;
  readonly onCollapseAll: () => void;
  readonly onExpandAll: () => void;
  readonly onFiltersChange: (next: CatalogFilters) => void;
  readonly providerOptions: readonly CatalogProviderStat[];
  readonly searchInputRef: RefObject<HTMLInputElement | null>;
  readonly summary: CatalogSummary;
}

export function CatalogToolbar({
  chips,
  compact,
  filters,
  onClearAll,
  onClearChip,
  onCollapseAll,
  onExpandAll,
  onFiltersChange,
  providerOptions,
  searchInputRef,
  summary,
}: CatalogToolbarProps) {
  const update = <K extends keyof CatalogFilters>(key: K, value: CatalogFilters[K]): void => {
    onFiltersChange({ ...filters, [key]: value });
  };

  const visionChip = (
    <ToggleChip
      icon={<Eye aria-hidden="true" className="size-3.5" />}
      label="Vision"
      onPressedChange={(pressed) => update('vision', pressed)}
      pressed={filters.vision}
    />
  );
  const reasoningChip = (
    <ToggleChip
      icon={<Sun aria-hidden="true" className="size-3.5" />}
      label="Reasoning"
      onPressedChange={(pressed) => update('reasoning', pressed)}
      pressed={filters.reasoning}
    />
  );
  const contextSelect = (
    <ContextSelect onChange={(band) => update('context', band)} value={filters.context} />
  );
  const activeFilterCount = [
    filters.vision,
    filters.reasoning,
    filters.context !== 'any',
    filters.providerIds.size > 0,
  ].filter(Boolean).length;

  return (
    <div className="flex shrink-0 flex-col gap-2" data-testid="model-catalog-toolbar">
      <div className="flex flex-wrap items-center gap-2">
        <div className={cn('relative', compact ? 'w-full' : 'w-72 shrink-0')}>
          <SettingsSearchIcon />
          <Input
            aria-label="Search models"
            className="h-8 pr-8 text-sm"
            data-testid="model-catalog-search"
            onChange={(event) => update('query', event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') {
                return;
              }
              if (filters.query) {
                event.preventDefault();
                update('query', '');
                return;
              }
              event.currentTarget.blur();
            }}
            placeholder="Search name, id, provider…"
            ref={searchInputRef}
            role="searchbox"
            style={SETTINGS_SEARCH_INPUT_STYLE}
            value={filters.query}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground"
          >
            /
          </span>
        </div>
        <Segmented
          label="Status"
          onChange={(status) => update('status', status)}
          options={STATUS_OPTIONS}
          value={filters.status}
        />
        <Segmented
          label="Type"
          onChange={(type) => update('type', type)}
          options={TYPE_OPTIONS}
          value={filters.type}
        />
        {compact ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                className="h-8 gap-1.5 px-3 text-xs"
                data-testid="model-catalog-filters-trigger"
                size="sm"
                variant="outline"
              >
                <SlidersHorizontal aria-hidden="true" className="size-3.5" />
                Filters
                {activeFilterCount > 0 ? (
                  <Badge className="h-4 px-1 text-[10px]" variant="secondary">
                    {activeFilterCount}
                  </Badge>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 space-y-3 p-3">
              <div className="flex flex-wrap items-center gap-2">
                {visionChip}
                {reasoningChip}
                {contextSelect}
              </div>
              <div className="space-y-1">
                <p className="font-medium text-muted-foreground text-xs">Providers</p>
                <ProvidersList
                  onChange={(ids) => update('providerIds', ids)}
                  options={providerOptions}
                  selected={filters.providerIds}
                />
              </div>
            </PopoverContent>
          </Popover>
        ) : (
          <>
            {visionChip}
            {reasoningChip}
            {contextSelect}
            <ProvidersPopover
              onChange={(ids) => update('providerIds', ids)}
              options={providerOptions}
              selected={filters.providerIds}
            />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <p aria-live="polite" className="text-muted-foreground" data-testid="model-catalog-summary">
          <SummaryText summary={summary} />
        </p>
        {chips.map((chip) => (
          <span
            className="inline-flex h-6 items-center gap-1 rounded-full border bg-muted/40 pr-1 pl-2.5"
            key={chip.key}
          >
            {chip.label}
            <button
              aria-label={`Remove filter ${chip.label}`}
              className="rounded-full p-0.5 hover:bg-accent"
              onClick={() => onClearChip(chip.key)}
              type="button"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </span>
        ))}
        {summary.filtering ? (
          <Button
            className="h-6 px-1.5 text-xs"
            data-testid="model-catalog-clear-filters"
            onClick={onClearAll}
            size="xs"
            variant="link"
          >
            Clear filters
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            data-testid="model-catalog-expand-all"
            onClick={onExpandAll}
            size="xs"
            variant="ghost"
          >
            <ChevronsUpDown aria-hidden="true" />
            Expand all
          </Button>
          <Button
            data-testid="model-catalog-collapse-all"
            onClick={onCollapseAll}
            size="xs"
            variant="ghost"
          >
            <ChevronsDownUp aria-hidden="true" />
            Collapse all
          </Button>
        </div>
      </div>
    </div>
  );
}
