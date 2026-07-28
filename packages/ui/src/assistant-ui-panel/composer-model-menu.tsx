/**
 * Claude-style composer model menu: curated top-level rows (selected model +
 * recents) with taglines and capability icons and a "More models" drill-down
 * over the full catalog. Selection ONLY — the reasoning Effort/Thinking
 * controls live in the always-visible ComposerEffortControl beside this menu
 * (BST-948), so picking a model and tuning effort are two visible one-click
 * controls instead of one nested menu.
 *
 * Selection is COMPOSITE-KEY ("provider::model") end-to-end — the menu never
 * resolves a bare model id back to a provider (the old modelToProviderMap
 * silently mis-resolved duplicate bare ids across providers).
 */
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Brain, Check, ChevronDown, Eye } from 'lucide-react';
import { type ComponentPropsWithoutRef, Fragment, useCallback, useMemo } from 'react';
import { Button } from '../button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../dropdown-menu';
import { cn } from '../lib/utils';
import type { ModelPickerModel } from '../model-picker';
import { formatContextWindow } from '../model-picker/utils/format-context-window';
import { getProviderColor } from '../model-picker/utils/provider-colors';
import type { ProviderGroupConfig, ProviderRuntimeCategory } from './assistant-ui-panel';

const MAX_RECENT_ROWS = 4;

const MODEL_KEY_DELIMITER = '::';

export function composerModelCompositeKey(providerId: string, modelId: string): string {
  return `${providerId}${MODEL_KEY_DELIMITER}${modelId}`;
}

/** Bare model id from a "provider::model" composite key (display only). */
export function modelIdFromCompositeKey(compositeKey: string | undefined): string | undefined {
  if (!compositeKey) {
    return;
  }
  const separatorIndex = compositeKey.indexOf(MODEL_KEY_DELIMITER);
  if (separatorIndex <= 0) {
    return compositeKey;
  }
  return compositeKey.slice(separatorIndex + MODEL_KEY_DELIMITER.length);
}

interface ComposerModelOption {
  compositeKey: string;
  /** The model's registry `default: true` flag (top-row fallback ordering). */
  isDefault: boolean;
  meta: ModelPickerModel | undefined;
  modelId: string;
  modelLabel: string;
  providerId: string;
  providerName: string;
}

/**
 * Top-level row keys: selected model first, then valid recents (deduped),
 * capped at 1 + MAX_RECENT_ROWS. Falls back to default-flagged models so the
 * top level is never empty while options exist.
 */
function collectTopOptionKeys(args: {
  optionByCompositeKey: ReadonlyMap<string, ComposerModelOption>;
  recentModels: readonly string[];
  selectedModel: string | undefined;
}): string[] {
  const { optionByCompositeKey, recentModels, selectedModel } = args;
  const keys: string[] = [];
  const seenKeys = new Set<string>();
  if (selectedModel && optionByCompositeKey.has(selectedModel)) {
    keys.push(selectedModel);
    seenKeys.add(selectedModel);
  }
  for (const key of recentModels) {
    if (keys.length >= 1 + MAX_RECENT_ROWS) {
      break;
    }
    if (!seenKeys.has(key) && optionByCompositeKey.has(key)) {
      keys.push(key);
      seenKeys.add(key);
    }
  }
  if (keys.length === 0) {
    for (const option of optionByCompositeKey.values()) {
      if (keys.length >= 1 + MAX_RECENT_ROWS) {
        break;
      }
      if (option.isDefault) {
        keys.push(option.compositeKey);
      }
    }
  }
  return keys;
}

interface ComposerModelGroup {
  label: string;
  providers: Array<{
    providerId: string;
    providerName: string;
    options: ComposerModelOption[];
  }>;
  runtime: ProviderRuntimeCategory;
}

export interface ComposerModelMenuProps {
  disabled?: boolean | undefined;
  onModelChange?: ((compositeKey: string) => void) | undefined;
  pickerModels: ModelPickerModel[];
  providerGroups: ProviderGroupConfig[];
  /** Composite keys, newest first; invalid entries are filtered upstream. */
  recentModels?: readonly string[] | undefined;
  /** Composite key "provider::model". */
  selectedModel?: string | undefined;
}

/**
 * Radio row with a trailing Check indicator (Claude-style) instead of the
 * shared circle indicator.
 */
const ModelMenuRadioItem = ({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>) => (
  <DropdownMenuPrimitive.RadioItem
    className={cn(
      'relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className
    )}
    data-slot="composer-model-menu-radio-item"
    {...props}
  >
    {children}
    <span className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check aria-hidden className="size-4" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
  </DropdownMenuPrimitive.RadioItem>
);

const CapabilityIcons = ({ meta }: { meta: ModelPickerModel | undefined }) => {
  if (!meta) {
    return null;
  }
  const { reasoning, vision } = meta.capabilities;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
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
};

const ModelRow = ({ option }: { option: ComposerModelOption }) => (
  <ModelMenuRadioItem value={option.compositeKey}>
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: getProviderColor(option.providerId, 'light') }}
    />
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium leading-5">{option.modelLabel}</span>
      {option.meta?.description ? (
        <span className="block truncate text-muted-foreground text-xs leading-4">
          {option.meta.description}
        </span>
      ) : null}
    </span>
    <CapabilityIcons meta={option.meta} />
  </ModelMenuRadioItem>
);

const DenseModelRow = ({ option }: { option: ComposerModelOption }) => (
  <ModelMenuRadioItem className="py-1" value={option.compositeKey}>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm leading-5">{option.modelLabel}</span>
    </span>
    {option.meta?.contextWindow ? (
      <span className="shrink-0 rounded-md border border-border/50 bg-background/55 px-1 text-[10px] text-muted-foreground">
        {formatContextWindow(option.meta.contextWindow)}
      </span>
    ) : null}
    <CapabilityIcons meta={option.meta} />
  </ModelMenuRadioItem>
);

export const ComposerModelMenu = ({
  disabled,
  onModelChange,
  pickerModels,
  providerGroups,
  recentModels,
  selectedModel,
}: ComposerModelMenuProps) => {
  const metaByCompositeKey = useMemo(() => {
    const map = new Map<string, ModelPickerModel>();
    for (const model of pickerModels) {
      map.set(composerModelCompositeKey(model.providerId, model.id), model);
    }
    return map;
  }, [pickerModels]);

  const groups = useMemo<ComposerModelGroup[]>(
    () =>
      providerGroups
        .map((group) => {
          const providers = group.providers
            .map((provider) => ({
              options: provider.models
                .filter((model) => model.enabled && model.type === 'llm')
                .map((model) => {
                  const compositeKey = composerModelCompositeKey(provider.id, model.id);
                  return {
                    compositeKey,
                    isDefault: Boolean(model.default),
                    meta: metaByCompositeKey.get(compositeKey),
                    modelId: model.id,
                    modelLabel: model.label,
                    providerId: provider.id,
                    providerName: provider.name,
                  };
                }),
              providerId: provider.id,
              providerName: provider.name,
            }))
            .filter((entry) => entry.options.length > 0);
          if (providers.length === 0) {
            return null;
          }
          return {
            label: group.label,
            providers,
            runtime: group.runtime,
          };
        })
        .filter((group): group is ComposerModelGroup => group !== null),
    [metaByCompositeKey, providerGroups]
  );

  const optionByCompositeKey = useMemo(() => {
    const map = new Map<string, ComposerModelOption>();
    for (const group of groups) {
      for (const provider of group.providers) {
        for (const option of provider.options) {
          map.set(option.compositeKey, option);
        }
      }
    }
    return map;
  }, [groups]);

  const selectedOption = selectedModel ? optionByCompositeKey.get(selectedModel) : undefined;

  const topOptions = useMemo<ComposerModelOption[]>(
    () =>
      collectTopOptionKeys({
        optionByCompositeKey,
        recentModels: recentModels ?? [],
        selectedModel,
      })
        .map((key) => optionByCompositeKey.get(key))
        .filter((option): option is ComposerModelOption => option !== undefined),
    [optionByCompositeKey, recentModels, selectedModel]
  );

  const hasOptions = optionByCompositeKey.size > 0;
  const canSelect = Boolean(onModelChange) && hasOptions && !disabled;

  const handleModelSelect = useCallback(
    (compositeKey: string) => {
      onModelChange?.(compositeKey);
    },
    [onModelChange]
  );

  const triggerText = selectedOption
    ? selectedOption.modelLabel
    : hasOptions
      ? 'Select a model...'
      : 'No models enabled';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Selected model: ${selectedOption?.modelLabel ?? 'none'}`}
          className="h-8 gap-2 rounded-full border-border/70 bg-background/85 px-3 text-xs"
          data-testid="composer-model-menu-trigger"
          disabled={!canSelect}
          size="sm"
          variant="outline"
        >
          {selectedOption ? (
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: getProviderColor(selectedOption.providerId, 'light') }}
            />
          ) : null}
          <span className="max-w-44 truncate">{triggerText}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 p-1">
        <DropdownMenuRadioGroup onValueChange={handleModelSelect} value={selectedModel ?? ''}>
          {topOptions.map((option) => (
            <ModelRow key={option.compositeKey} option={option} />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className="text-sm"
              data-testid="composer-more-models-trigger"
              disabled={!hasOptions}
            >
              More models
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-[min(60vh,480px)] w-64 overflow-y-auto p-1">
              {groups.map((group) => (
                <Fragment key={group.runtime}>
                  <DropdownMenuLabel className="px-2 text-[10px] text-muted-foreground uppercase tracking-wide">
                    {group.label}
                  </DropdownMenuLabel>
                  {group.providers.map((provider) => (
                    <DropdownMenuSub key={provider.providerId}>
                      <DropdownMenuSubTrigger className="text-sm">
                        <span className="flex-1 truncate">{provider.providerName}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {provider.options.length}
                        </span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="max-h-[min(60vh,480px)] w-80 overflow-y-auto p-1">
                        {provider.options.map((option) => (
                          <DenseModelRow key={option.compositeKey} option={option} />
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
                </Fragment>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
