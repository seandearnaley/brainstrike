import type { FileChunk, FileRecord } from '@brainstrike/db';
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
} from '@brainstrike/ui';
import { Database, FileCode2, Files, Gauge, ScanSearch, ScrollText, Trash2 } from 'lucide-react';
import type { SettingsPanelProps } from '../types';

interface ExtendedSettingsPanelProps extends SettingsPanelProps {
  /** Clear database dialog controls - optional for backwards compatibility */
  clearDatabaseProps?: {
    clearAllData: (() => Promise<unknown>) | null;
    records: FileRecord[];
    chunks: FileChunk[];
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
    value: 'auto',
    label: 'Auto',
    description: 'Selects the best splitter from file type and document shape.',
  },
  {
    value: 'semantic-markdown',
    label: 'Semantic Markdown',
    description: 'Keeps related heading families together for guides and docs.',
  },
  {
    value: 'markdown',
    label: 'Markdown',
    description: 'Markdown-aware splitting with heading and block boundaries.',
  },
  {
    value: 'recursive',
    label: 'Recursive',
    description: 'Code and structure aware splitting with boundary-first recursion.',
  },
  {
    value: 'sentence',
    label: 'Sentence',
    description: 'General text splitting that favors natural sentence boundaries.',
  },
  {
    value: 'token',
    label: 'Token',
    description: 'Token-budget-oriented splits for large-context retrieval.',
  },
  {
    value: 'character',
    label: 'Character',
    description: 'Fixed-width splitting when uniform chunk size matters most.',
  },
  {
    value: 'html',
    label: 'HTML / XML',
    description: 'Structure-aware splitting across block and tag boundaries.',
  },
  {
    value: 'json',
    label: 'JSON',
    description: 'Chunk structured payloads around arrays, objects, and entries.',
  },
  {
    value: 'latex',
    label: 'LaTeX',
    description: 'Favors chapter, section, and environment boundaries.',
  },
];

function renderPresetIcon(presetId: string) {
  switch (presetId) {
    case 'balanced':
      return <Gauge className="h-4 w-4" />;
    case 'codebase':
      return <FileCode2 className="h-4 w-4" />;
    case 'strict-code':
      return <FileCode2 className="h-4 w-4" />;
    case 'docs':
      return <ScrollText className="h-4 w-4" />;
    case 'api-reference':
      return <ScanSearch className="h-4 w-4" />;
    case 'structured-data':
      return <Database className="h-4 w-4" />;
    case 'large-context':
      return <Files className="h-4 w-4" />;
    default:
      return <Gauge className="h-4 w-4" />;
  }
}

interface ChunkingPresetListProps {
  currentPreset: ChunkingPresetSelection;
  onChoosePreset: (value: ChunkingPresetSelection) => void;
  presets: readonly ChunkingPresetDefinition[];
}

function ChunkingPresetList({ currentPreset, onChoosePreset, presets }: ChunkingPresetListProps) {
  return (
    <div className="space-y-3">
      <div className="grid max-h-[min(32vh,260px)] gap-2 overflow-y-auto pr-1">
        {presets.map((preset) => {
          const isActive = currentPreset === preset.id;
          return (
            <button
              aria-pressed={isActive}
              className={cn(
                'group rounded-2xl border px-3 py-3 text-left transition-colors focus-visible:outline-none',
                isActive
                  ? 'border-foreground/20 bg-foreground/5 shadow-sm'
                  : 'border-border/70 bg-background/70 hover:border-foreground/15 hover:bg-muted/70'
              )}
              data-testid={`chunking-preset-${preset.id}`}
              key={preset.id}
              onClick={() => onChoosePreset(preset.id)}
              type="button"
            >
              <div className="flex items-start gap-3">
                <div
                  className={cn(
                    'rounded-xl border p-2',
                    isActive ? 'border-foreground/15 bg-background' : 'border-border/60'
                  )}
                >
                  {renderPresetIcon(preset.id)}
                </div>
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-medium text-base leading-none">{preset.label}</div>
                    {preset.isDefault ? <Badge variant="secondary">Default</Badge> : null}
                  </div>
                  <div
                    className="flex flex-wrap gap-1.5"
                    data-testid={`chunking-preset-status-${preset.id}`}
                  >
                    <Badge variant={preset.adaptiveRouting ? 'secondary' : 'outline'}>
                      {preset.adaptiveRouting ? 'Adaptive' : 'Fixed'}
                    </Badge>
                    <Badge variant="outline">{preset.strategy}</Badge>
                  </div>
                  <p className="line-clamp-2 text-muted-foreground text-sm leading-5">
                    {preset.description}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="rounded-2xl border border-border/70 border-dashed bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground leading-5">
        Presets are intentionally opinionated. Start here, then use the controls below to tighten
        locality, widen retrieval windows, or pin a specific structure-aware splitter.
      </div>
    </div>
  );
}

function PresetMetricRow({ items }: { items: [string, string] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      <span>{items[0]}</span>
      <span>{items[1]}</span>
    </div>
  );
}

function ChunkingPresetSummary({
  importSettings,
  preset,
}: {
  importSettings: ExtendedSettingsPanelProps['importSettings'];
  preset: ChunkingPresetDefinition | null;
}) {
  if (!preset) {
    return (
      <div className="rounded-2xl border border-foreground/15 bg-background/90 px-4 py-4 shadow-sm">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-medium text-lg leading-none">Custom tuning</div>
            <Badge variant="outline">Manual</Badge>
          </div>
          <p className="text-muted-foreground text-sm leading-6">
            You&apos;ve diverged from a preset. The controls below are now the source of truth for
            chunk size, overlap, and structure bias.
          </p>
        </div>
        <div className="mt-3 grid gap-2 text-[11px] text-muted-foreground uppercase tracking-[0.14em] sm:grid-cols-2">
          <PresetMetricRow
            items={[importSettings.chunkingStrategy, `${importSettings.chunkSize} size`]}
          />
          <PresetMetricRow
            items={[
              `${importSettings.chunkOverlap} overlap`,
              `${importSettings.chunkTokenLimit} cap`,
            ]}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-foreground/15 bg-background/90 px-4 py-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="rounded-xl border border-foreground/15 bg-background p-2.5">
          {renderPresetIcon(preset.id)}
        </div>
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-medium text-lg leading-none">{preset.label}</div>
            <Badge variant={preset.adaptiveRouting ? 'secondary' : 'outline'}>
              {preset.adaptiveRouting ? 'Adaptive' : 'Fixed'}
            </Badge>
            {preset.isDefault ? <Badge variant="secondary">Default</Badge> : null}
          </div>
          <p className="text-muted-foreground text-sm leading-6">{preset.description}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {preset.bestFor.slice(0, 4).map((item) => (
          <Badge
            className="max-w-full whitespace-normal text-[11px]"
            key={`${preset.id}-${item}`}
            variant="outline"
          >
            {item}
          </Badge>
        ))}
      </div>

      <div className="mt-3 grid gap-2 text-[11px] text-muted-foreground uppercase tracking-[0.14em] sm:grid-cols-2">
        <PresetMetricRow items={[preset.strategy, `${preset.chunkSize} size`]} />
        <PresetMetricRow items={[`${preset.chunkOverlap} overlap`, `${preset.tokenLimit} cap`]} />
      </div>

      <p className="mt-3 text-[12px] text-muted-foreground leading-6">{preset.tradeoff}</p>
    </div>
  );
}

export function SettingsPanel({
  importSettings,
  clearDatabaseProps,
  className,
}: ExtendedSettingsPanelProps) {
  const presets = getChunkingPresetDefinitions();
  const chunkingId = 'enable-chunking';
  const presetCaps = ['2048', '4096', '6144', '8192'];
  const selectedPreset = presetCaps.includes(String(importSettings.chunkTokenLimit))
    ? String(importSettings.chunkTokenLimit)
    : 'custom';
  const accurateCounting = useTokenPreferencesStore(tokenPreferencesSelectors.accurateCounting);
  const selectedStrategy = STRATEGY_OPTIONS.find(
    (option) => option.value === importSettings.chunkingStrategy
  );
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
  const currentPreset = importSettings.chunkingPreset;
  const currentPresetDefinition =
    currentPreset === 'custom'
      ? null
      : (presets.find((preset) => preset.id === currentPreset) ?? null);
  const routePreview = getChunkingRoutePreview(importSettings.chunkingStrategy);
  const choosePreset = (value: ChunkingPresetSelection) => {
    importSettings.setChunkingPreset(value);
  };
  return (
    <div
      className={cn(
        'mt-2 max-h-[min(78vh,720px)] space-y-4 overflow-y-auto rounded-xl border border-border/70 bg-[linear-gradient(180deg,hsl(var(--background))_0%,hsl(var(--muted)/0.6)_100%)] p-4 pr-3 shadow-sm',
        className
      )}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <Label className="text-xs uppercase tracking-[0.18em]" htmlFor={chunkingId}>
            Chunking Studio
          </Label>
          <p className="max-w-2xl text-muted-foreground text-xs leading-5">
            Tune how imported files become retrieval-ready chunks. Start with a preset, then
            override the advanced controls only when you need to bias for precision, code locality,
            or larger retrieval windows.
          </p>
        </div>
        <label
          className="flex w-fit items-center gap-2 rounded-full border border-border/80 bg-background px-3 py-1.5 font-medium text-xs"
          htmlFor={chunkingId}
        >
          <input
            checked={importSettings.enableChunking}
            className="h-3.5 w-3.5"
            id={chunkingId}
            onChange={(e) => importSettings.setEnableChunking(e.target.checked)}
            type="checkbox"
          />
          Enable chunking
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <ChunkingPresetList
          currentPreset={currentPreset}
          onChoosePreset={choosePreset}
          presets={presets}
        />
        <ChunkingPresetSummary importSettings={importSettings} preset={currentPresetDefinition} />
      </div>

      <div className="grid gap-4 rounded-2xl border border-border/70 bg-background/80 p-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div>
          <Label className="text-xs">Strategy</Label>
          <Select
            onValueChange={(value) => importSettings.setChunkingStrategy(value as ChunkingStrategy)}
            value={importSettings.chunkingStrategy}
          >
            <SelectTrigger className="mt-1 h-9 text-sm">
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
          <p className="mt-2 text-muted-foreground text-xs">{selectedStrategy.description}</p>
        </div>
        <div>
          <Label className="text-xs">Preset state</Label>
          <div className="mt-1 rounded-xl border border-border/80 border-dashed bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm">
                {currentPreset === 'custom' ? 'Custom tuning' : currentPresetDefinition?.label}
              </span>
              {currentPreset === 'custom' ? (
                <Button onClick={() => choosePreset('balanced')} size="sm" variant="outline">
                  Reset to Balanced
                </Button>
              ) : (
                <Badge variant="outline">Preset linked</Badge>
              )}
            </div>
            <p className="mt-2 text-muted-foreground text-xs">
              Editing size, overlap, strategy, or token cap promotes this profile to custom so you
              can push precision further without losing the curated starting points.
            </p>
            {currentPresetDefinition ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {currentPresetDefinition.adaptiveRouting
                  ? 'Adaptive presets still route each file type to its best canonical splitter.'
                  : 'Fixed presets force one primary splitter across every imported file.'}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label className="text-xs">Routing plan</Label>
            <p className="mt-1 text-muted-foreground text-xs">
              Preview how this setup routes common file types before you import anything.
            </p>
          </div>
          <Badge variant="outline">
            {importSettings.chunkingStrategy === 'auto' ? 'Auto routing' : 'Forced strategy'}
          </Badge>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {routePreview.map((route) => (
            <div
              className="rounded-xl border border-border/70 bg-muted/30 p-3"
              data-testid={`chunking-route-${route.fileName.replaceAll(/[/.]/g, '-')}`}
              key={route.fileName}
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-medium text-sm">{route.label}</p>
                  <p className="text-[11px] text-muted-foreground">{route.fileName}</p>
                </div>
                <Badge variant="secondary">{route.resolvedStrategy}</Badge>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground leading-5">{route.reason}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <Label className="text-xs">Chunk size</Label>
          <Input
            className="mt-1 h-9 text-sm"
            max="2048"
            min="128"
            onChange={(e) => importSettings.setChunkSize(Number(e.target.value))}
            type="number"
            value={importSettings.chunkSize}
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            The target span for each chunk before token safety splitting applies.
          </p>
        </div>
        <div>
          <Label className="text-xs">Overlap</Label>
          <Input
            className="mt-1 h-9 text-sm"
            max="256"
            min="0"
            onChange={(e) => importSettings.setChunkOverlap(Number(e.target.value))}
            type="number"
            value={importSettings.chunkOverlap}
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            Shared context between neighboring chunks to preserve continuity.
          </p>
        </div>
        <div>
          <Label className="text-xs">Token cap</Label>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <Input
              className="h-9 text-sm"
              max="16384"
              min="512"
              onChange={(e) => {
                const nextValue = Number(e.target.value);
                importSettings.setChunkTokenLimit(
                  Number.isFinite(nextValue) ? Math.min(16_384, Math.max(512, nextValue)) : 512
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
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Presets" />
              </SelectTrigger>
              <SelectContent>
                {presetCaps.map((cap) => (
                  <SelectItem className="text-xs" key={cap} value={cap}>
                    {cap} tokens
                  </SelectItem>
                ))}
                <SelectItem className="text-xs" value="custom">
                  Custom
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Higher caps reduce chunk count at the cost of larger embedding payloads.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-2xl border px-3 py-2">
        <div>
          <Label className="text-xs">Token sizing</Label>
          <p className="text-[10px] text-muted-foreground">
            Controlled globally via Settings → Token Counting.
          </p>
        </div>
        <Badge
          className="text-[10px] uppercase"
          variant={accurateCounting ? 'secondary' : 'outline'}
        >
          {accurateCounting ? 'WASM tokenizer' : 'Heuristic mode'}
        </Badge>
      </div>

      {/* Clear Database - Dangerous operation, placed at bottom of settings */}
      {clearDatabaseProps && (
        <div className="mt-3 border-border/50 border-t pt-3">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-muted-foreground text-xs">Danger Zone</Label>
              <p className="text-[10px] text-muted-foreground">
                Clear all imported files and chunks from database.
              </p>
            </div>
            <Button
              className="flex h-7 items-center gap-1"
              disabled={
                clearDatabaseProps.clearing ||
                !clearDatabaseProps.clearAllData ||
                (clearDatabaseProps.records.length === 0 && clearDatabaseProps.chunks.length === 0)
              }
              onClick={() => clearDatabaseProps.setShowClearDialog(true)}
              size="sm"
              variant="destructive"
            >
              <Trash2 className="h-3 w-3" />
              Clear Database
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
