/**
 * Shared reasoning-control primitives consumed by BOTH the composer model
 * menu (Effort submenu / Thinking toggle) and the slimmed
 * ProviderSettingsPanel ("Output & Limits"). Settings-update parity is the
 * contract here: the builders below must emit BYTE-IDENTICAL
 * `AssistantProviderSettingsUpdate` payloads to the pre-split
 * ProviderSettingsPanel sections (pinned by write-through tests) so moving a
 * control between surfaces can never change what gets persisted or sent.
 */
import type { ReasoningControlsAvailability } from '@brainstrike/assistant-contract';
import type {
  AnthropicEffort,
  AssistantProviderSettings,
  AssistantProviderSettingsUpdate,
  BedrockReasoningEffort,
  GoogleThinkingLevel,
  OpenAiReasoningEffort,
} from '@brainstrike/types';
import { clampNumber } from './assistant-ui-panel-utils';

export const ANTHROPIC_THINKING_DEFAULT = 12_000;
export const ANTHROPIC_THINKING_MIN = 1024;
export const ANTHROPIC_THINKING_MAX = 20_000;
export const ANTHROPIC_THINKING_STEP = 256;

export const OPENAI_EFFORT_LABELS: Record<OpenAiReasoningEffort, string> = {
  high: 'High',
  low: 'Low',
  max: 'Max',
  medium: 'Medium',
  minimal: 'Minimal',
  none: 'None',
  xhigh: 'Extra',
};

export const ANTHROPIC_EFFORT_LABELS: Record<AnthropicEffort, string> = {
  high: 'High',
  low: 'Low',
  max: 'Max',
  medium: 'Medium',
  xhigh: 'Extra',
};

/**
 * Same words as the Anthropic ladder, kept as its own record because the two
 * mirror independent upstream enums — an addition to either must not silently
 * relabel the other's menu.
 */
export const BEDROCK_EFFORT_LABELS: Record<BedrockReasoningEffort, string> = {
  high: 'High',
  low: 'Low',
  max: 'Max',
  medium: 'Medium',
  xhigh: 'Extra',
};

export const GOOGLE_THINKING_LEVEL_LABELS: Record<GoogleThinkingLevel, string> = {
  high: 'High',
  low: 'Low',
  medium: 'Medium',
  minimal: 'Minimal',
};

export interface EffortOption {
  /** Marks the model's declared default effort ("Default" chip). */
  isModelDefault: boolean;
  label: string;
  value: string;
}

export interface EffortControlModel {
  /** Build the byte-identical settings update for a picked radio value. */
  buildUpdate: (value: string) => AssistantProviderSettingsUpdate;
  /** Muted trigger annotation, e.g. "High" or "Auto". */
  currentLabel: string;
  /** The radio value currently in effect ('auto' when unset). */
  currentValue: string;
  options: EffortOption[];
}

/**
 * Derive the Effort submenu model for an available controls family. Returns
 * undefined for families without an effort/level list (local) — the caller
 * hides the Effort row.
 */
export function buildEffortControlModel(
  availability: ReasoningControlsAvailability,
  settings: AssistantProviderSettings
): EffortControlModel | undefined {
  if (!availability.available) {
    return;
  }

  switch (availability.family) {
    case 'openai':
    case 'openrouter': {
      const current = settings.reasoningEffort;
      const isKnown = current !== undefined && availability.efforts.includes(current);
      const options: EffortOption[] = availability.efforts.map((effort) => ({
        isModelDefault: availability.defaultEffort === effort,
        label: OPENAI_EFFORT_LABELS[effort],
        value: effort,
      }));
      if (current !== undefined && !isKnown) {
        // The persisted effort (e.g. legacy 'none') is no longer in the
        // model's advertised list, but it's still what gets sent to the
        // provider — surface it as its own option instead of silently
        // falling back to "Auto", which would make the visible selection
        // lie about the active request.
        options.push({
          isModelDefault: false,
          label: OPENAI_EFFORT_LABELS[current],
          value: current,
        });
      }
      return {
        // Parity with OpenAiReasoningSection: 'auto' clears the setting,
        // anything else writes the literal effort value.
        buildUpdate: (value) => ({
          reasoningEffort: value === 'auto' ? undefined : (value as OpenAiReasoningEffort),
        }),
        currentLabel: current === undefined ? 'Auto' : OPENAI_EFFORT_LABELS[current],
        currentValue: current ?? 'auto',
        options,
      };
    }
    case 'anthropic': {
      const current = settings.anthropicEffort;
      return {
        // Parity with AnthropicReasoningSection's effort select.
        buildUpdate: (value) => ({
          anthropicEffort: value === 'auto' ? undefined : (value as AnthropicEffort),
        }),
        currentLabel: current ? ANTHROPIC_EFFORT_LABELS[current] : 'Auto',
        currentValue: current ?? 'auto',
        options: availability.efforts.map((effort) => ({
          isModelDefault: false,
          label: ANTHROPIC_EFFORT_LABELS[effort],
          value: effort,
        })),
      };
    }
    case 'bedrock': {
      const current = settings.bedrockEffort;
      return {
        // Its own settings key, not `anthropicEffort` — Bedrock has no
        // thinking-budget control, so the Anthropic pair would leave a toggle
        // writing state the Bedrock request builder drops (BST-1354).
        buildUpdate: (value) => ({
          bedrockEffort: value === 'auto' ? undefined : (value as BedrockReasoningEffort),
        }),
        currentLabel: current ? BEDROCK_EFFORT_LABELS[current] : 'Auto',
        currentValue: current ?? 'auto',
        options: availability.efforts.map((effort) => ({
          isModelDefault: false,
          label: BEDROCK_EFFORT_LABELS[effort],
          value: effort,
        })),
      };
    }
    case 'google': {
      const current = settings.googleThinkingLevel;
      return {
        // Parity with GoogleThinkingSection's level select.
        buildUpdate: (value) => ({
          googleThinkingLevel: value === 'auto' ? undefined : (value as GoogleThinkingLevel),
        }),
        currentLabel: current ? GOOGLE_THINKING_LEVEL_LABELS[current] : 'Auto',
        currentValue: current ?? 'auto',
        options: availability.levels.map((level) => ({
          isModelDefault: false,
          label: GOOGLE_THINKING_LEVEL_LABELS[level],
          value: level,
        })),
      };
    }
    case 'local':
      return;
    default: {
      const exhausted: never = availability;
      throw new Error(`Unhandled reasoning family: ${String(exhausted)}`);
    }
  }
}

export interface EffortSliderStop {
  /** The vendor's recommended effort for this model, if it declares one. */
  isModelDefault: boolean;
  label: string;
  value: string;
}

export interface EffortSliderModel {
  /** Byte-identical settings update for a track position. */
  buildUpdateForIndex: (index: number) => AssistantProviderSettingsUpdate;
  /** Track position currently in effect. */
  index: number;
  /** Ordered stops, `auto` pinned first so the track reads low -> high. */
  stops: EffortSliderStop[];
  /** Screen-reader announcement for the active stop. */
  valueText: string;
}

/**
 * Canonical weakest-to-strongest effort order.
 *
 * A slider is an ORDINAL axis: dragging right must mean "think harder". Menu
 * sources are under no such obligation — OpenRouter's live model metadata lists
 * efforts strongest-first, which as a radio list is merely a presentation
 * choice but as a track silently inverts the control. Ranking here makes the
 * axis correct no matter what order the resolver hands over.
 *
 * Unranked values sort last (before `auto`, which is pinned separately) rather
 * than being dropped — an unknown effort still has to be reachable.
 */
const EFFORT_TRACK_ORDER: readonly string[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function effortRank(value: string): number {
  const rank = EFFORT_TRACK_ORDER.indexOf(value);
  return rank === -1 ? EFFORT_TRACK_ORDER.length : rank;
}

/**
 * Project the family-normalized effort model onto a single ordered track.
 *
 * Effort is inherently ordinal, so a discrete slider expresses it in one
 * gesture where the nested submenu needed open -> hover -> click. Stops are
 * sorted weakest-to-strongest (see EFFORT_TRACK_ORDER) and `auto` is pinned at
 * position 0 as the "let the vendor decide" end of the same axis rather than
 * living in a separate control.
 */
export function buildEffortSliderModel(model: EffortControlModel): EffortSliderModel {
  const ordered = model.options.toSorted(
    (left, right) => effortRank(left.value) - effortRank(right.value)
  );
  const stops: EffortSliderStop[] = [
    { isModelDefault: false, label: 'Auto', value: 'auto' },
    ...ordered,
  ];
  const foundIndex = stops.findIndex((stop) => stop.value === model.currentValue);
  // An unresolvable current value would silently mis-position the thumb, so
  // fall back to `auto` — position 0 always exists.
  const index = foundIndex >= 0 ? foundIndex : 0;
  const active = stops[index];
  const valueText = active?.isModelDefault
    ? `${active.label} (recommended)`
    : (active?.label ?? 'Auto');
  return {
    buildUpdateForIndex: (nextIndex) => {
      const stop = stops[nextIndex];
      if (!stop) {
        throw new Error(`Effort slider index ${nextIndex} is outside the track.`);
      }
      return model.buildUpdate(stop.value);
    },
    index,
    stops,
    valueText,
  };
}

export interface ThinkingToggleModel {
  buildUpdate: (checked: boolean) => AssistantProviderSettingsUpdate;
  checked: boolean;
}

/**
 * The primary Thinking toggle (anthropic budget set/clear, local
 * enable/disable). Families without a toggle return undefined.
 */
export function buildThinkingToggleModel(
  availability: ReasoningControlsAvailability,
  settings: AssistantProviderSettings
): ThinkingToggleModel | undefined {
  if (!availability.available) {
    return;
  }

  if (availability.family === 'anthropic') {
    const thinkingValue = clampNumber(
      settings.anthropicThinkingBudgetTokens ?? ANTHROPIC_THINKING_DEFAULT,
      ANTHROPIC_THINKING_MIN,
      ANTHROPIC_THINKING_MAX
    );
    return {
      // The toggle is authoritative for "is Claude thinking at all". An effort
      // alone now implies adaptive thinking, so switching off must clear the
      // effort too — otherwise the runtime keeps requesting thinking while the
      // switch reads unchecked.
      buildUpdate: (checked) =>
        checked
          ? { anthropicThinkingBudgetTokens: thinkingValue }
          : { anthropicEffort: undefined, anthropicThinkingBudgetTokens: undefined },
      checked:
        typeof settings.anthropicThinkingBudgetTokens === 'number' ||
        Boolean(settings.anthropicEffort),
    };
  }

  if (availability.family === 'local') {
    return {
      // Parity with the old LocalThinkingSection switch.
      buildUpdate: (checked) => ({ localThinkingEnabled: checked }),
      checked: settings.localThinkingEnabled ?? true,
    };
  }

  return;
}
