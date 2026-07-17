import {
  tokenPreferencesSelectors,
  useTokenPreferencesStore,
} from '@brainstrike/preferences/stores/token-preferences-store';
import {
  type ChunkingPresetSelection,
  type ChunkingStrategy,
  getChunkingPresetDefinitions,
  getChunkingRoutePreview,
} from '@brainstrike/text-splitter';
import {
  Badge,
  Button,
  cn,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import {
  ChevronDown,
  Database,
  FileCode2,
  Files,
  Gauge,
  ScanSearch,
  ScrollText,
  Sliders,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import type { SettingsPanelProps } from '../types';

interface ExtendedSettingsPanelProps extends SettingsPanelProps {
  /** Clear database dialog controls - optional for backwards compatibility */
  clearDatabaseProps?: {
    clearAllData: (() => Promise<unknown>) | null;
    recordsCount: number;
    chunksCount: number;
    countsPending?: boolean;
    clearing: boolean;
    showClearDialog: boolean;
    setShowClearDialog: (show: boolean) => void;
    onClear: () => void;
  };
}

interface StrategyOption {
  description: string;
  label: string;
  value: ChunkingStrategy;
}

type ChunkingPresetDefinition = ReturnType<typeof getChunkingPresetDefinitions>[number];

const STRATEGY_OPTIONS: StrategyOption[] = [
  {
    description: 'Selects the best splitter from file type and document shape.',
    label: 'Auto',
    value: 'auto',
  },
  {
    description: 'Keeps related heading families together for guides and docs.',
    label: 'Semantic Markdown',
    value: 'semantic-markdown',
  },
  {
    description: 'Markdown-aware splitting with heading and block boundaries.',
    label: 'Markdown',
    value: 'markdown',
  },
  {
    description: 'Code and structure aware splitting with boundary-first recursion.',
    label: 'Recursive',
    value: 'recursive',
  },
  {
    description: 'General text splitting that favors natural sentence boundaries.',
    label: 'Sentence',
    value: 'sentence',
  },
  {
    description: 'Token-budget-oriented splits for large-context retrieval.',
    label: 'Token',
    value: 'token',
  },
  {
    description: 'Fixed-width splitting when uniform chunk size matters most.',
    label: 'Character',
    value: 'character',
  },
  {
    description: 'Structure-aware splitting across block and tag boundaries.',
    label: 'HTML / XML',
    value: 'html',
  },
  {
    description: 'Chunk structured payloads around arrays, objects, and entries.',
    label: 'JSON',
    value: 'json',
  },
  {
    description: 'Favors chapter, section, and environment boundaries.',
    label: 'LaTeX',
    value: 'latex',
  },
];

const PRESET_ICONS: Record<string, typeof Gauge> = {
  'api-reference': ScanSearch,
  balanced: Gauge,
  codebase: FileCode2,
  docs: ScrollText,
  'large-context': Files,
  'strict-code': FileCode2,
  'structured-data': Database,
};

function PresetIcon({ presetId, className }: { presetId: string; className?: string }) {
  const Icon = PRESET_ICONS[presetId] ?? Gauge;
  return <Icon aria-hidden className={className ?? 'h-3.5 w-3.5'} />;
}

interface DisclosureProps {
  children: ReactNode;
  defaultOpen?: boolean;
  icon?: ReactNode;
  meta?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  testId?: string;
  title: string;
}

/**
 * Lightweight disclosure that keeps content out of the DOM while collapsed
 * — same a11y pattern as <details>/<summary> but without the default styles.
 */
function Disclosure({
  defaultOpen = false,
  icon,
  meta,
  open: controlledOpen,
  onOpenChange,
  testId,
  title,
  children,
}: DisclosureProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const toggle = () => {
    const next = !open;
    if (controlledOpen === undefined) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  };
  return (
    <div
      className="rounded-xl border border-border/70 bg-background/60"
      data-state={open ? 'open' : 'closed'}
      data-testid={testId}
    >
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onClick={toggle}
        type="button"
      >
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        <span className="font-medium">{title}</span>
        {meta ? (
          <span className="ml-auto flex items-center gap-2 text-muted-foreground text-xs">
            {meta}
          </span>
        ) : null}
        <ChevronDown
          aria-hidden
          className={cn(
            'size-4 text-muted-foreground transition-transform',
            meta ? '' : 'ml-auto',
            open ? 'rotate-180' : ''
          )}
        />
      </button>
      {open ? <div className="border-border/60 border-t px-3 py-3">{children}</div> : null}
    </div>
  );
}

/**
 * Pill rendered inside TooltipContent. The tooltip surface is dark
 * (bg-foreground), so badges must use inverse colors to stay readable.
 * Using sibling-colored Badge variants here would render dark-on-dark.
 */
function TooltipChip({ children, emphasis }: { children: ReactNode; emphasis?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-1.5 py-0.5 font-medium text-[10px]',
        emphasis
          ? 'border-background/0 bg-background text-foreground'
          : 'border-background/30 bg-background/10 text-background'
      )}
    >
      {children}
    </span>
  );
}

interface PresetPillProps {
  isActive: boolean;
  onSelect: (id: ChunkingPresetSelection) => void;
  preset: ChunkingPresetDefinition;
}

function PresetPill({ preset, isActive, onSelect }: PresetPillProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-pressed={isActive}
          className={cn(
            'group inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 font-medium text-xs transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            isActive
              ? 'border-foreground/30 bg-foreground text-background shadow-sm'
              : 'border-border/70 bg-background/80 text-foreground hover:border-foreground/20 hover:bg-muted'
          )}
          data-testid={`chunking-preset-${preset.id}`}
          onClick={() => onSelect(preset.id)}
          type="button"
        >
          <PresetIcon className="h-3.5 w-3.5" presetId={preset.id} />
          <span>{preset.label}</span>
          {/* Status badges kept in DOM (sr-only) for tests + assistive tech. */}
          <span className="sr-only" data-testid={`chunking-preset-status-${preset.id}`}>
            {preset.adaptiveRouting ? 'Adaptive' : 'Fixed'} {preset.strategy}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1.5" side="bottom">
        <div className="flex items-center gap-1.5 font-medium text-background">
          <PresetIcon className="h-3.5 w-3.5" presetId={preset.id} />
          {preset.label}
          {preset.isDefault ? <TooltipChip>Default</TooltipChip> : null}
        </div>
        <p className="text-[11px] text-background/85 leading-5">{preset.description}</p>
        <div className="flex flex-wrap gap-1 pt-1">
          <TooltipChip emphasis>{preset.adaptiveRouting ? 'Adaptive' : 'Fixed'}</TooltipChip>
          <TooltipChip>{preset.strategy}</TooltipChip>
          <TooltipChip>{preset.chunkSize} size</TooltipChip>
          <TooltipChip>{preset.tokenLimit} cap</TooltipChip>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

interface ActivePresetChipProps {
  importSettings: ExtendedSettingsPanelProps['importSettings'];
  preset: ChunkingPresetDefinition | null;
}

function ActivePresetChip({ preset, importSettings }: ActivePresetChipProps) {
  if (!preset) {
    return (
      <div
        className="inline-flex items-center gap-1.5 rounded-full border border-foreground/20 bg-background/80 px-2.5 py-1 text-xs"
        data-testid="chunking-active-preset"
      >
        <Sparkles aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">Custom tuning</span>
        <span className="text-muted-foreground">
          · {importSettings.chunkingStrategy} · {importSettings.chunkSize}/
          {importSettings.chunkOverlap}
        </span>
      </div>
    );
  }
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-foreground/20 bg-background/80 px-2.5 py-1 text-xs"
      data-testid="chunking-active-preset"
    >
      <PresetIcon className="h-3.5 w-3.5 text-foreground" presetId={preset.id} />
      <span className="font-medium">{preset.label}</span>
      <span className="text-muted-foreground">
        · {preset.adaptiveRouting ? 'Adaptive' : 'Fixed'} · {preset.strategy}
      </span>
    </div>
  );
}

export function SettingsPanel({
  importSettings,
  clearDatabaseProps,
  className,
}: ExtendedSettingsPanelProps) {
  const presets = getChunkingPresetDefinitions();
  const chunkingId = useId();
  const presetCaps = ['2048', '4096', '6144', '8192'];
  const selectedPreset = presetCaps.includes(String(importSettings.chunkTokenLimit))
    ? String(importSettings.chunkTokenLimit)
    : 'custom';
  const accurateCounting = useTokenPreferencesStore(tokenPreferencesSelectors.accurateCounting);
  const selectedStrategy = STRATEGY_OPTIONS.find(
    (option) => option.value === importSettings.chunkingStrategy
  );
  const currentPreset = importSettings.chunkingPreset;
  const currentPresetDefinition =
    currentPreset === 'custom'
      ? null
      : (presets.find((preset) => preset.id === currentPreset) ?? null);
  const isCustom = currentPreset === 'custom';
  // Initial open state seeds from the current preset. The popover unmounts on
  // close, so a fresh open after promotion to "custom" will re-init to true
  // without needing an effect to sync.
  const [advancedOpen, setAdvancedOpen] = useState(isCustom);

  if (!selectedStrategy) {
    return (
      <div
        className={cn(
          'mt-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm',
          className
        )}
        role="alert"
      >
        <div className="font-medium">Chunking Studio configuration error</div>
        <p className="mt-2 text-muted-foreground leading-6">
          Persisted chunking settings are invalid. The saved strategy value{' '}
          <code className="rounded bg-background px-1 py-0.5 text-xs">
            {String(importSettings.chunkingStrategy)}
          </code>{' '}
          is not recognized by this build. Update or reset the import settings before editing
          chunking preferences.
        </p>
      </div>
    );
  }

  const routePreview = getChunkingRoutePreview(importSettings.chunkingStrategy);
  const choosePreset = (value: ChunkingPresetSelection) => {
    importSettings.setChunkingPreset(value);
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn(
          'mt-2 max-h-[min(78vh,640px)] space-y-3 overflow-y-auto rounded-xl border border-border/70 bg-[linear-gradient(180deg,hsl(var(--background))_0%,hsl(var(--muted)/0.45)_100%)] p-3 shadow-sm',
          className
        )}
      >
        {/* Header: title + active preset + enable toggle. One row on wide screens, wraps on narrow. */}
        <header className="flex flex-wrap items-center gap-2">
          <Label
            className="text-[10px] uppercase tracking-[0.18em]"
            htmlFor={`${chunkingId}-toggle`}
          >
            Chunking Studio
          </Label>
          <ActivePresetChip importSettings={importSettings} preset={currentPresetDefinition} />
          {currentPresetDefinition?.isDefault ? (
            <Badge className="text-[10px]" variant="secondary">
              Default
            </Badge>
          ) : null}
          {isCustom ? (
            <Button
              className="h-6 px-2 text-[11px]"
              onClick={() => choosePreset('balanced')}
              size="sm"
              variant="outline"
            >
              Reset to Balanced
            </Button>
          ) : null}
          <label
            className="ml-auto flex items-center gap-2 text-xs"
            htmlFor={`${chunkingId}-toggle`}
          >
            <span className="text-muted-foreground">Enable chunking</span>
            <Switch
              aria-label="Enable chunking"
              checked={importSettings.enableChunking}
              id={`${chunkingId}-toggle`}
              onCheckedChange={(value) => importSettings.setEnableChunking(value)}
            />
          </label>
        </header>

        {/* Compact preset selector — horizontal scroll on narrow screens. */}
        <fieldset className="-mx-1 flex flex-wrap gap-1.5 overflow-x-auto px-1 pb-1">
          <legend className="sr-only">Chunking presets</legend>
          {presets.map((preset) => (
            <PresetPill
              isActive={currentPreset === preset.id}
              key={preset.id}
              onSelect={choosePreset}
              preset={preset}
            />
          ))}
        </fieldset>

        {/* Inline summary strip — single line of meta for the current selection. */}
        {currentPresetDefinition ? (
          <p className="px-1 text-muted-foreground text-xs leading-5">
            <span className="text-foreground">{currentPresetDefinition.description}</span>{' '}
            <span className="text-muted-foreground/80">
              · {currentPresetDefinition.chunkSize} size · {currentPresetDefinition.chunkOverlap}{' '}
              overlap · {currentPresetDefinition.tokenLimit} cap
            </span>
          </p>
        ) : (
          <p className="px-1 text-muted-foreground text-xs leading-5">
            You&apos;ve diverged from a preset — the advanced controls below are now the source of
            truth.
          </p>
        )}

        {/* Routing plan disclosure */}
        <Disclosure
          icon={<ScanSearch className="size-3.5" />}
          meta={
            <Badge className="text-[10px]" variant="outline">
              {importSettings.chunkingStrategy === 'auto' ? 'Auto routing' : 'Forced strategy'}
            </Badge>
          }
          testId="chunking-routing-plan"
          title="Routing plan"
        >
          <p className="mb-3 text-muted-foreground text-xs">
            Preview how this setup routes common file types before you import anything.
          </p>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {routePreview.map((route) => (
              <div
                className="rounded-lg border border-border/60 bg-muted/30 p-2.5"
                data-testid={`chunking-route-${route.fileName.replaceAll(/[/.]/g, '-')}`}
                key={route.fileName}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-sm">{route.label}</p>
                    <p className="truncate text-[10px] text-muted-foreground">{route.fileName}</p>
                  </div>
                  <Badge className="text-[10px]" variant="secondary">
                    {route.resolvedStrategy}
                  </Badge>
                </div>
                <p className="mt-1.5 text-[10px] text-muted-foreground leading-4">{route.reason}</p>
              </div>
            ))}
          </div>
        </Disclosure>

        {/* Advanced controls disclosure */}
        <Disclosure
          icon={<Sliders className="size-3.5" />}
          meta={
            isCustom ? (
              <Badge className="text-[10px]" variant="outline">
                Editing custom
              </Badge>
            ) : null
          }
          onOpenChange={setAdvancedOpen}
          open={advancedOpen}
          testId="chunking-advanced"
          title="Advanced controls"
        >
          <div className="space-y-3">
            <div>
              <Label className="text-xs" htmlFor={`${chunkingId}-strategy`}>
                Strategy
              </Label>
              <Select
                onValueChange={(value) =>
                  importSettings.setChunkingStrategy(value as ChunkingStrategy)
                }
                value={importSettings.chunkingStrategy}
              >
                <SelectTrigger className="mt-1 h-8 text-sm" id={`${chunkingId}-strategy`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STRATEGY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {selectedStrategy.description}
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <Label className="text-xs" htmlFor={`${chunkingId}-size`}>
                  Chunk size
                </Label>
                <Input
                  className="mt-1 h-8 text-sm"
                  id={`${chunkingId}-size`}
                  max="2048"
                  min="128"
                  onChange={(e) => importSettings.setChunkSize(Number(e.target.value))}
                  type="number"
                  value={importSettings.chunkSize}
                />
              </div>
              <div>
                <Label className="text-xs" htmlFor={`${chunkingId}-overlap`}>
                  Overlap
                </Label>
                <Input
                  className="mt-1 h-8 text-sm"
                  id={`${chunkingId}-overlap`}
                  max="256"
                  min="0"
                  onChange={(e) => importSettings.setChunkOverlap(Number(e.target.value))}
                  type="number"
                  value={importSettings.chunkOverlap}
                />
              </div>
              <div>
                <Label className="text-xs" htmlFor={`${chunkingId}-cap`}>
                  Token cap
                </Label>
                <div className="mt-1 grid grid-cols-[1fr_auto] gap-1.5">
                  <Input
                    className="h-8 text-sm"
                    id={`${chunkingId}-cap`}
                    max="16384"
                    min="512"
                    onChange={(e) => {
                      const nextValue = Number(e.target.value);
                      importSettings.setChunkTokenLimit(
                        Number.isFinite(nextValue)
                          ? Math.min(16_384, Math.max(512, nextValue))
                          : 512
                      );
                    }}
                    step="128"
                    type="number"
                    value={importSettings.chunkTokenLimit}
                  />
                  <Select
                    onValueChange={(value) => {
                      if (value === 'custom') {
                        return;
                      }
                      importSettings.setChunkTokenLimit(Number(value));
                    }}
                    value={selectedPreset}
                  >
                    <SelectTrigger aria-label="Token cap preset" className="h-8 w-[5.5rem] text-xs">
                      <SelectValue placeholder="Presets" />
                    </SelectTrigger>
                    <SelectContent>
                      {presetCaps.map((cap) => (
                        <SelectItem className="text-xs" key={cap} value={cap}>
                          {cap}
                        </SelectItem>
                      ))}
                      <SelectItem className="text-xs" value="custom">
                        Custom
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground leading-5">
              Editing any field promotes this profile to <span className="font-medium">custom</span>{' '}
              so you can push precision further without losing the curated starting points.
            </p>
          </div>
        </Disclosure>

        {/* Footer: tokenizer mode + danger zone, on one compact row. */}
        <footer className="flex flex-wrap items-center justify-between gap-2 border-border/60 border-t pt-2">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>Token sizing</span>
            <Badge
              className="text-[10px] uppercase"
              variant={accurateCounting ? 'secondary' : 'outline'}
            >
              {accurateCounting ? 'WASM tokenizer' : 'Heuristic mode'}
            </Badge>
          </div>
          {clearDatabaseProps && (
            <Button
              className="flex h-7 items-center gap-1"
              disabled={
                clearDatabaseProps.clearing ||
                clearDatabaseProps.countsPending ||
                !clearDatabaseProps.clearAllData ||
                (clearDatabaseProps.recordsCount === 0 && clearDatabaseProps.chunksCount === 0)
              }
              onClick={() => clearDatabaseProps.setShowClearDialog(true)}
              size="sm"
              variant="destructive"
            >
              <Trash2 className="h-3 w-3" />
              {clearDatabaseProps.countsPending ? 'Counts pending' : 'Clear All Collections'}
            </Button>
          )}
        </footer>
      </div>
    </TooltipProvider>
  );
}
