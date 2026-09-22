/**
 * Search-first composer model picker (BST-1795): Popover + cmdk. Opening
 * focuses search; an empty query shows Recent then enabled models grouped
 * by provider; typing flattens to provider-labelled enabled matches plus
 * disabled registry-backed matches under "Not enabled", which are enabled
 * through the host and selected only once that write commits. Reasoning
 * Effort/Thinking controls stay OUT of this picker (BST-948).
 */
import {
  Button,
  formatContextWindow,
  getProviderColor,
  type ModelPickerModel,
  ModelPickerSearch,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@brainstrike/ui';
import { Command } from 'cmdk';
import { Brain, Check, ChevronDown, Eye, Plus } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import type { ProviderGroupConfig } from './assistant-ui-panel';
import { buildComposerPickerSections, type ComposerPickerEntry } from './composer-picker-sections';

export { composerModelCompositeKey, modelIdFromCompositeKey } from './composer-picker-sections';

export interface ComposerModelPickerProps {
  disabled?: boolean | undefined;
  /** Enable a registry-backed model. Resolves true once committed; false after the host reported the failure. */
  onEnableModel?: ((providerId: string, modelId: string) => Promise<boolean>) | undefined;
  onModelChange?: ((compositeKey: string) => void) | undefined;
  pickerModels: ModelPickerModel[];
  providerGroups: ProviderGroupConfig[];
  /** Composite keys, newest first; invalid entries are filtered here. */
  recentModels?: readonly string[] | undefined;
  /** Composite key "provider::model". */
  selectedModel?: string | undefined;
}

const GROUP_HEADING_CLASS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide';

const ROW_CLASS =
  'flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden aria-selected:bg-accent aria-selected:text-accent-foreground data-[disabled=true]:opacity-50';

function triggerLabel(selectedEntry: ComposerPickerEntry | undefined, hasOptions: boolean): string {
  if (selectedEntry) {
    return selectedEntry.modelLabel;
  }
  if (hasOptions) {
    return 'Select a model...';
  }
  return 'No models enabled';
}

function CapabilityIcons({ meta }: { meta: ModelPickerModel | undefined }): ReactNode {
  if (!meta) {
    return null;
  }
  const { reasoning, vision } = meta.capabilities;
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
      {vision === 'supported' ? (
        <Eye aria-label="Vision" className="size-3.5" role="img">
          <title>Supports image input</title>
        </Eye>
      ) : null}
      {reasoning === 'supported' ? (
        <Brain aria-label="Reasoning" className="size-3.5" role="img">
          <title>Supports reasoning</title>
        </Brain>
      ) : null}
      {reasoning === 'unknown' ? (
        <Brain aria-label="Reasoning unverified" className="size-3.5 opacity-40" role="img">
          <title>Reasoning support unverified</title>
        </Brain>
      ) : null}
    </span>
  );
}

function ProviderDot({ providerId }: { providerId: string }): ReactNode {
  return (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: getProviderColor(providerId, 'light') }}
    />
  );
}

function SelectedMark({ selected }: { selected: boolean }): ReactNode {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {selected ? <Check aria-label="Selected" className="size-4" role="img" /> : null}
    </span>
  );
}

interface RowProps {
  entry: ComposerPickerEntry;
  onPick: (entry: ComposerPickerEntry) => void;
  selected: boolean;
  showProvider: boolean;
}

function RecentRow({ entry, onPick, selected }: Omit<RowProps, 'showProvider'>): ReactNode {
  return (
    <Command.Item
      className={ROW_CLASS}
      onSelect={() => onPick(entry)}
      value={`recent:${entry.compositeKey}`}
    >
      <ProviderDot providerId={entry.providerId} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium leading-5">{entry.modelLabel}</span>
        {entry.meta?.description ? (
          <span className="block truncate text-muted-foreground text-xs leading-4">
            {entry.meta.description}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{entry.providerName}</span>
      <CapabilityIcons meta={entry.meta} />
      <SelectedMark selected={selected} />
    </Command.Item>
  );
}

function ListRow({ entry, onPick, selected, showProvider }: RowProps): ReactNode {
  return (
    <Command.Item className={ROW_CLASS} onSelect={() => onPick(entry)} value={entry.compositeKey}>
      {showProvider ? <ProviderDot providerId={entry.providerId} /> : null}
      <span className="min-w-0 flex-1 truncate leading-5">{entry.modelLabel}</span>
      {showProvider ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">{entry.providerName}</span>
      ) : null}
      {entry.meta?.contextWindow ? (
        <span className="shrink-0 rounded-md border border-border/50 bg-background/55 px-1 text-[10px] text-muted-foreground">
          {formatContextWindow(entry.meta.contextWindow)}
        </span>
      ) : null}
      <CapabilityIcons meta={entry.meta} />
      <SelectedMark selected={selected} />
    </Command.Item>
  );
}

function NotEnabledRow({
  entry,
  onEnable,
  pending,
}: {
  entry: ComposerPickerEntry;
  onEnable: (entry: ComposerPickerEntry) => void;
  pending: boolean;
}): ReactNode {
  return (
    <Command.Item
      aria-label={`Enable and select ${entry.modelLabel} (${entry.providerName})`}
      className={ROW_CLASS}
      disabled={pending}
      onSelect={() => onEnable(entry)}
      value={`enable:${entry.compositeKey}`}
    >
      <ProviderDot providerId={entry.providerId} />
      <span className="min-w-0 flex-1 truncate text-muted-foreground leading-5">
        {entry.modelLabel}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{entry.providerName}</span>
      <Plus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </Command.Item>
  );
}

export function ComposerModelPicker({
  disabled,
  onEnableModel,
  onModelChange,
  pickerModels,
  providerGroups,
  recentModels,
  selectedModel,
}: ComposerModelPickerProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // Selection-intent token: bumped by every pick and every close, so a
  // pending enable that resolves later never overrides a newer choice.
  const selectionTokenRef = useRef(0);

  const sections = useMemo(
    () =>
      buildComposerPickerSections({
        pickerModels,
        providerGroups,
        query,
        recentModels: recentModels ?? [],
        selectedModel,
      }),
    [pickerModels, providerGroups, query, recentModels, selectedModel]
  );

  const selectedEntry = selectedModel ? sections.enabledByKey.get(selectedModel) : undefined;
  const hasOptions = sections.enabledByKey.size > 0;
  const canSelect = Boolean(onModelChange) && hasOptions && !disabled;
  const triggerText = triggerLabel(selectedEntry, hasOptions);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      selectionTokenRef.current += 1;
      setQuery('');
    }
  }, []);

  const handlePick = useCallback(
    (entry: ComposerPickerEntry) => {
      selectionTokenRef.current += 1;
      onModelChange?.(entry.compositeKey);
      handleOpenChange(false);
    },
    [handleOpenChange, onModelChange]
  );

  const handleEnable = useCallback(
    async (entry: ComposerPickerEntry) => {
      if (!onEnableModel || pendingKey) {
        return;
      }
      const token = selectionTokenRef.current;
      setPendingKey(entry.compositeKey);
      let committed: boolean;
      try {
        committed = await onEnableModel(entry.providerId, entry.modelId);
      } finally {
        // Always clear, even when the host violates its contract and rejects;
        // the rejection itself still propagates.
        setPendingKey(null);
      }
      // A false result was already reported by the host (destructive toast);
      // the selection deliberately stays where it was. A newer pick or a
      // close since the request abandons only the selection — the enable
      // write itself has committed.
      if (committed && selectionTokenRef.current === token) {
        handlePick(entry);
      }
    },
    [handlePick, onEnableModel, pendingKey]
  );

  const isSearching = query.trim().length > 0;
  const notEnabled = onEnableModel ? sections.notEnabled : [];

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={`Selected model: ${selectedEntry?.modelLabel ?? 'none'}`}
          className="h-8 gap-2 rounded-full border-border/70 bg-background/85 px-3 text-xs"
          data-testid="composer-model-menu-trigger"
          disabled={!canSelect}
          size="sm"
          variant="outline"
        >
          {selectedEntry ? <ProviderDot providerId={selectedEntry.providerId} /> : null}
          <span className="max-w-44 truncate">{triggerText}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Choose a model"
        className="w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-xl p-0"
        sideOffset={6}
      >
        <Command className="flex flex-col" label="Models" shouldFilter={false}>
          <ModelPickerSearch
            onValueChange={setQuery}
            placeholder="Search models..."
            value={query}
          />
          <Command.List className="max-h-[min(60vh,420px)] overflow-y-auto p-1">
            <Command.Empty className="px-2 py-6 text-center text-muted-foreground text-sm">
              No models match “{query.trim()}”.
            </Command.Empty>
            {isSearching ? null : (
              <>
                {sections.recent.length > 0 ? (
                  <Command.Group className={GROUP_HEADING_CLASS} heading="Recent">
                    {sections.recent.map((entry) => (
                      <RecentRow
                        entry={entry}
                        key={entry.compositeKey}
                        onPick={handlePick}
                        selected={entry.compositeKey === selectedModel}
                      />
                    ))}
                  </Command.Group>
                ) : null}
                {sections.groups.map((group) => (
                  <Command.Group
                    className={GROUP_HEADING_CLASS}
                    heading={`${group.runtimeLabel} · ${group.providerName} ${group.entries.length}`}
                    key={group.providerId}
                  >
                    {group.entries.map((entry) => (
                      <ListRow
                        entry={entry}
                        key={entry.compositeKey}
                        onPick={handlePick}
                        selected={entry.compositeKey === selectedModel}
                        showProvider={false}
                      />
                    ))}
                  </Command.Group>
                ))}
              </>
            )}
            {isSearching && sections.matches.length > 0 ? (
              <Command.Group className={GROUP_HEADING_CLASS} heading="Models">
                {sections.matches.map((entry) => (
                  <ListRow
                    entry={entry}
                    key={entry.compositeKey}
                    onPick={handlePick}
                    selected={entry.compositeKey === selectedModel}
                    showProvider
                  />
                ))}
              </Command.Group>
            ) : null}
            {isSearching && notEnabled.length > 0 ? (
              <Command.Group className={GROUP_HEADING_CLASS} heading="Not enabled">
                {notEnabled.map((entry) => (
                  <NotEnabledRow
                    entry={entry}
                    key={entry.compositeKey}
                    onEnable={(target) => {
                      void handleEnable(target);
                    }}
                    pending={pendingKey !== null}
                  />
                ))}
              </Command.Group>
            ) : null}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
