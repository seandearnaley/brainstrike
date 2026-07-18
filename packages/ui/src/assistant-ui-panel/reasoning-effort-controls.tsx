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
  medium: 'Medium',
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
      return {
        // Parity with OpenAiReasoningSection: 'auto' clears the setting,
        // anything else writes the literal effort value.
        buildUpdate: (value) => ({
          reasoningEffort: value === 'auto' ? undefined : (value as OpenAiReasoningEffort),
        }),
        currentLabel: isKnown ? OPENAI_EFFORT_LABELS[current] : 'Auto',
        currentValue: isKnown ? current : 'auto',
        options: availability.efforts.map((effort) => ({
          isModelDefault: availability.defaultEffort === effort,
          label: OPENAI_EFFORT_LABELS[effort],
          value: effort,
        })),
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
      // Parity with AnthropicReasoningSection's thinking-budget switch.
      buildUpdate: (checked) => ({
        anthropicThinkingBudgetTokens: checked ? thinkingValue : undefined,
      }),
      checked: typeof settings.anthropicThinkingBudgetTokens === 'number',
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
