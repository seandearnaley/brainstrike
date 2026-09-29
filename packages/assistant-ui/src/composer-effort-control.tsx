/**
 * Always-visible reasoning control for the composer control dock (BST-948).
 *
 * The effort/thinking settings used to live INSIDE the model dropdown, which
 * meant two menu trips (model, then effort) and zero visibility of the active
 * setting once the menu closed. This control sits next to the model picker:
 * the trigger itself is the readout ("Effort High" / "Thinking Off"), and one
 * click opens a popover with the same slider/toggle rows.
 *
 * Settings-update parity contract: all updates go through the builders in
 * reasoning-effort-controls.tsx and stay byte-identical to the pre-split
 * ProviderSettingsPanel sections — moving the control between surfaces must
 * never change what gets persisted or sent.
 */
import {
  type OpenRouterModelMetadataLookup,
  resolveReasoningControlsAvailability,
} from '@brainstrike/assistant-contract';
import type {
  AssistantProviderSettings,
  AssistantProviderSettingsMap,
  AssistantProviderSettingsUpdate,
} from '@brainstrike/types';
import { Button, Popover, PopoverContent, PopoverTrigger, Switch } from '@brainstrike/ui';
import { Brain, ChevronDown } from 'lucide-react';
import { useCallback } from 'react';
import { modelIdFromCompositeKey } from './composer-picker-sections';
import { useOpenRouterModelMetadataLookup } from './openrouter-model-metadata-context';
import {
  buildEffortControlModel,
  buildEffortSliderModel,
  buildThinkingToggleModel,
  type EffortControlModel,
  type ThinkingToggleModel,
} from './reasoning-effort-controls';

export interface ComposerEffortControlProps {
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  providerSettings?: AssistantProviderSettingsMap | undefined;
  /** Composite key "provider::model" (same shape the model menu receives). */
  selectedModel?: string | undefined;
  selectedProvider?: string | undefined;
}

function resolveAvailability(
  providerId: string | undefined,
  modelId: string | undefined,
  lookup: OpenRouterModelMetadataLookup | undefined
): ReturnType<typeof resolveReasoningControlsAvailability> | undefined {
  if (!providerId) {
    return;
  }
  const metadata = lookup?.state === 'resolved' ? lookup.snapshot.metadata : undefined;
  return resolveReasoningControlsAvailability(providerId, modelId, metadata);
}

const EffortSliderRow = ({
  effortModel,
  onPick,
}: {
  effortModel: EffortControlModel;
  onPick: (updates: AssistantProviderSettingsUpdate) => void;
}) => {
  const slider = buildEffortSliderModel(effortModel);
  const maxIndex = slider.stops.length - 1;
  return (
    <div
      className="flex select-none flex-col gap-1.5 px-2 py-1.5"
      data-testid="composer-effort-row"
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-sm">Effort</span>
        <span className="text-muted-foreground text-xs" data-testid="composer-effort-value">
          {slider.valueText}
        </span>
      </span>
      <input
        aria-label="Reasoning effort"
        aria-valuetext={slider.valueText}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        data-testid="composer-effort-slider"
        max={maxIndex}
        min={0}
        onChange={(event) => onPick(slider.buildUpdateForIndex(Number(event.target.value)))}
        step={1}
        type="range"
        value={slider.index}
      />
      <span aria-hidden="true" className="flex justify-between text-[10px] text-muted-foreground">
        {slider.stops.map((stop) => (
          <span className={stop.isModelDefault ? 'text-foreground' : undefined} key={stop.value}>
            {stop.label}
            {stop.isModelDefault ? '•' : ''}
          </span>
        ))}
      </span>
    </div>
  );
};

const ThinkingToggleRow = ({
  onPick,
  thinkingModel,
}: {
  onPick: (updates: AssistantProviderSettingsUpdate) => void;
  thinkingModel: ThinkingToggleModel;
}) => (
  <div
    className="flex select-none items-start justify-between gap-3 px-2 py-1.5 text-sm"
    data-testid="composer-thinking-row"
  >
    <span className="min-w-0">
      <span className="block font-medium text-sm">Thinking</span>
      <span className="block text-muted-foreground text-xs">Can think for more complex tasks</span>
    </span>
    <Switch
      aria-label="Toggle thinking"
      checked={thinkingModel.checked}
      className="mt-0.5"
      onCheckedChange={(checked) => onPick(thinkingModel.buildUpdate(checked))}
    />
  </div>
);

export const ComposerEffortControl = ({
  onProviderSettingsChange,
  providerSettings,
  selectedModel,
  selectedProvider,
}: ComposerEffortControlProps) => {
  const openRouterMetadataLookup = useOpenRouterModelMetadataLookup();

  const handleSettingsUpdate = useCallback(
    (updates: AssistantProviderSettingsUpdate) => {
      if (!(onProviderSettingsChange && selectedProvider)) {
        return;
      }
      onProviderSettingsChange(selectedProvider, updates);
    },
    [onProviderSettingsChange, selectedProvider]
  );

  const availability = resolveAvailability(
    selectedProvider,
    modelIdFromCompositeKey(selectedModel),
    openRouterMetadataLookup
  );
  if (!availability) {
    return null;
  }
  const activeSettings: AssistantProviderSettings =
    (selectedProvider ? providerSettings?.[selectedProvider] : undefined) ?? {};
  const effortModel = buildEffortControlModel(availability, activeSettings);
  const thinkingModel = buildThinkingToggleModel(availability, activeSettings);
  if (!(effortModel || thinkingModel)) {
    return null;
  }

  // The trigger IS the readout: what runs next must be legible without a
  // single click. Thinking-capable families lead with the on/off state
  // (an effort label alone would imply thinking even when it's off), and an
  // implicit "Auto" effort reads as the explicit word "On" — "Thinking Auto"
  // is ambiguous against "Thinking Off" at a glance.
  const explicitEffortLabel =
    effortModel && effortModel.currentValue !== 'auto' ? effortModel.currentLabel : undefined;
  const readout = thinkingModel
    ? {
        label: 'Thinking',
        value: thinkingModel.checked ? (explicitEffortLabel ?? 'On') : 'Off',
      }
    : { label: 'Effort', value: effortModel?.currentLabel ?? 'Auto' };

  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* No aria-label: the accessible name must contain the visible text
            (WCAG 2.5.3 Label in Name — speech input says "click Effort High").
            The sr-only qualifier keeps the name a superset, never a rewrite. */}
        <Button
          className="h-8 gap-1.5 rounded-full border-border/70 bg-background/85 px-3 text-xs"
          data-testid="composer-effort-trigger"
          disabled={!onProviderSettingsChange}
          size="sm"
          variant="outline"
        >
          <Brain aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          {readout.label === 'Effort' ? <span className="sr-only">Reasoning</span> : null}
          <span className="text-muted-foreground">{readout.label}</span>
          <span className="max-w-24 truncate font-medium">{readout.value}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-1.5"
        data-testid="composer-effort-popover"
        side="top"
        sideOffset={8}
      >
        {thinkingModel ? (
          <ThinkingToggleRow onPick={handleSettingsUpdate} thinkingModel={thinkingModel} />
        ) : null}
        {effortModel ? (
          <EffortSliderRow effortModel={effortModel} onPick={handleSettingsUpdate} />
        ) : null}
      </PopoverContent>
    </Popover>
  );
};
