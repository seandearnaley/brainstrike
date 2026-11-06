/**
 * Search-first composer model picker (BST-1795) on the shared `ModelMenu`.
 * Opening focuses search; an empty query shows Recent then enabled models
 * grouped by provider; typing flattens to enabled matches plus disabled
 * registry-backed matches under "Not enabled", which are enabled through the
 * host and selected only once that write commits. Each row is the model's
 * maker mark, its name and its capability icons. Reasoning Effort/Thinking
 * controls stay out of this picker (BST-948).
 */
import {
  Button,
  ModelMark,
  ModelMenu,
  type ModelMenuGroup,
  type ModelMenuOption,
  type ModelPickerModel,
  modelMarkLabel,
  ProviderIcon,
} from '@brainstrike/ui';
import { Brain, ChevronDown, Eye, Plus } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderGroupConfig } from './assistant-ui-panel';
import { buildComposerPickerSections, type ComposerPickerEntry } from './composer-picker-sections';

export interface ComposerModelPickerProps {
  disabled?: boolean | undefined;
  /** Enable a registry-backed model. Resolves true once committed; false after the host reported the failure. */
  onEnableModel?: ((providerId: string, modelId: string) => Promise<boolean>) | undefined;
  /** Opens the host's model settings; absent, the empty state offers no link there. */
  onManageModels?: (() => void) | undefined;
  onModelChange?: ((compositeKey: string) => void) | undefined;
  pickerModels: ModelPickerModel[];
  providerGroups: ProviderGroupConfig[];
  /** Composite keys, newest first; invalid entries are filtered here. */
  recentModels?: readonly string[] | undefined;
  /** Composite key "provider::model". */
  selectedModel?: string | undefined;
}

function triggerLabel(selectedEntry: ComposerPickerEntry | undefined, hasOptions: boolean): string {
  if (selectedEntry) {
    return selectedEntry.modelLabel;
  }
  if (hasOptions) {
    return 'Select a model…';
  }
  return 'No models enabled';
}

function CapabilityIcons({ meta }: { meta: ModelPickerModel | undefined }): ReactNode {
  if (!meta) {
    return null;
  }
  const { reasoning, vision } = meta.capabilities;
  return (
    <span className="text-muted-foreground flex shrink-0 items-center gap-1">
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

/** "Anthropic", or "Anthropic via OpenRouter": the row's maker, which its text never names. */
function markLabelOf(entry: ComposerPickerEntry): string {
  return modelMarkLabel({
    providerId: entry.providerId,
    providerName: entry.providerName,
    vendorId: entry.vendor?.id,
    vendorName: entry.vendor?.name,
  });
}

/** A provider group's heading: its mark and name. */
function GroupHeading({ name, providerId }: { name: string; providerId: string }): ReactNode {
  return (
    <span className="flex items-center gap-1.5">
      <ProviderIcon className="size-3 shrink-0" providerId={providerId} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** The open picker with nothing enabled: says so, and offers the host's model settings when it has them. */
function NoEnabledModels({
  onManageModels,
}: {
  onManageModels: (() => void) | undefined;
}): ReactNode {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-sm">
      <p className="font-medium">No models are enabled</p>
      {onManageModels ? (
        <Button onClick={onManageModels} size="sm" type="button" variant="outline">
          Manage models
        </Button>
      ) : null}
    </div>
  );
}

export function ComposerModelPicker({
  disabled,
  onEnableModel,
  onManageModels,
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
  // Open with nothing enabled too: the empty state leads to enabling a model.
  const canSelect = Boolean(onModelChange) && !disabled;
  const triggerText = triggerLabel(selectedEntry, hasOptions);

  // An external change to `selectedModel` (another control, or the pick
  // this component itself just made) invalidates any enable still in
  // flight; unmounting does the same, so a resolution that lands after
  // either can never call handlePick with a stale selection.
  useEffect(
    () => () => {
      selectionTokenRef.current += 1;
    },
    [selectedModel]
  );

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
      const enable = async () => onEnableModel(entry.providerId, entry.modelId);
      const committed = await enable().finally(() => {
        // Always clear, even when the host violates its contract and rejects;
        // the rejection itself still propagates.
        setPendingKey(null);
      });
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
  const option = (entry: ComposerPickerEntry, key = entry.compositeKey): ModelMenuOption => ({
    key,
    label: entry.modelLabel,
    markLabel: markLabelOf(entry),
    onSelect: () => handlePick(entry),
    provider: entry.providerId,
    selected: entry.compositeKey === selectedModel,
    trailing: <CapabilityIcons meta={entry.meta} />,
    vendor: entry.vendor?.id,
  });
  const notEnabled = onEnableModel ? sections.notEnabled : [];
  const groups: ModelMenuGroup[] = isSearching
    ? [
        {
          heading: 'Models',
          key: 'models',
          options: sections.matches.map((entry) => option(entry)),
        },
        {
          heading: 'Not enabled',
          key: 'not-enabled',
          options: notEnabled.map((entry) => ({
            ariaLabel: `Enable and select ${entry.modelLabel} (${markLabelOf(entry)})`,
            disabled: pendingKey !== null,
            key: `enable:${entry.compositeKey}`,
            label: entry.modelLabel,
            markLabel: markLabelOf(entry),
            onSelect: () => {
              void handleEnable(entry);
            },
            provider: entry.providerId,
            trailing: <Plus aria-hidden className="text-muted-foreground size-3.5 shrink-0" />,
            vendor: entry.vendor?.id,
          })),
        },
      ]
    : [
        {
          heading: 'Recent',
          key: 'recent',
          options: sections.recent.map((entry) => option(entry, `recent:${entry.compositeKey}`)),
        },
        ...sections.groups.map((group) => ({
          heading: <GroupHeading name={group.providerName} providerId={group.providerId} />,
          key: `${group.runtime}:${group.providerId}`,
          options: group.entries.map((entry) => option(entry)),
        })),
      ];

  return (
    <ModelMenu
      aria-label="Choose a model"
      empty={
        <NoEnabledModels
          onManageModels={
            onManageModels
              ? () => {
                  // Settings opens beside the chat, not over it: close the
                  // picker first, as every other exit does.
                  handleOpenChange(false);
                  onManageModels();
                }
              : undefined
          }
        />
      }
      groups={groups}
      onOpenChange={handleOpenChange}
      onQueryChange={setQuery}
      open={open}
      query={query}
      trigger={
        <button
          aria-label={`Selected model: ${selectedEntry?.modelLabel ?? 'none'}`}
          className="bs-composer-chip"
          data-testid="composer-model-menu-trigger"
          disabled={!canSelect}
          type="button"
        >
          {selectedEntry ? (
            <ModelMark
              className="text-foreground/80"
              provider={selectedEntry.providerId}
              vendor={selectedEntry.vendor?.id}
            />
          ) : null}
          <span className="bs-composer-chip-label">{triggerText}</span>
          <ChevronDown aria-hidden />
        </button>
      }
    />
  );
}
