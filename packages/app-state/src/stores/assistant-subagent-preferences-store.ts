/**
 * Subagent limits — per turn tree and per child (Settings → Subagents → Subagent limits).
 *
 * `settings` is a complete `RuntimeSubagentSettings`; every setter validates
 * the WHOLE next value through the contract parser, so a field that would
 * violate a range or a cross-field rule THROWS and nothing lands (no silent
 * coercion — AGENTS.md). Persisted hydration sanitizes an invalid payload back
 * to the defaults. Sent to the host as `runtimeData.subagentSettings`.
 */

import {
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  parseRuntimeSubagentSettings,
  type RuntimeSubagentSettings,
  RuntimeSubagentSettingsError,
} from '@brainstrike/assistant-contract/subagent-settings';
import { persistDurable } from '@brainstrike/storage';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge.ts';

interface AssistantSubagentPreferencesData {
  settings: RuntimeSubagentSettings;
}

interface AssistantSubagentPreferencesActions {
  resetToDefaults: () => void;
  /** `null` turns the limit Off. */
  setMaxChildRuntimeMs: (value: number | null) => void;
  setMaxChildSteps: (value: number) => void;
  setMaxConcurrentWork: (value: number) => void;
  setMaxDepth: (value: number) => void;
  setMaxInvocations: (value: number) => void;
  /** `null` turns the limit Off. */
  setMaxStepOutputTokens: (value: number | null) => void;
  /** `null` turns the limit Off. */
  setSynthesisOutputTokens: (value: number | null) => void;
}

export type AssistantSubagentPreferencesStore = AssistantSubagentPreferencesData &
  AssistantSubagentPreferencesActions;

export const ASSISTANT_SUBAGENT_PREFERENCES_STORE_NAME =
  'brainstrike:assistant-subagent-preferences.v1' as const;
const STORE_VERSION = 4 as const;

function defaultData(): AssistantSubagentPreferencesData {
  return { settings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS };
}

/** Persisted-payload sanitizer: anything the contract rejects → defaults. */
function sanitizePersistedData(persistedState: unknown): AssistantSubagentPreferencesData {
  if (!(persistedState && typeof persistedState === 'object')) {
    return defaultData();
  }
  const candidate = (persistedState as { settings?: unknown }).settings;
  try {
    return { settings: parseRuntimeSubagentSettings(candidate) };
  } catch (error) {
    if (error instanceof RuntimeSubagentSettingsError) {
      return defaultData();
    }
    throw error;
  }
}

/**
 * Each version adds fields the strict schema requires; without these steps it
 * would reject an older shape and the sanitizer would silently reset every
 * saved budget to the defaults. Saved values always carry over.
 * - v1 predates `maxChildRuntimeMs`: it starts Off.
 * - v2 predates the tree limits (they were host constants): they start at the
 *   defaults.
 * - v3 carries the per-child and per-turn output budgets the host never
 *   enforced; they are dropped. Its step and summary output caps still at the
 *   old defaults (8,192 and 2,048) take the new default, Off; any other saved
 *   value carries over.
 */
function migratePersistedData(persistedState: unknown, version: number): unknown {
  if (version >= STORE_VERSION || !(persistedState && typeof persistedState === 'object')) {
    return persistedState;
  }
  const settings = (persistedState as { settings?: unknown }).settings;
  if (!(settings && typeof settings === 'object')) {
    return persistedState;
  }
  const defaults = DEFAULT_RUNTIME_SUBAGENT_SETTINGS;
  const {
    maxChildOutputTokens: _child,
    maxTreeOutputTokens: _tree,
    ...saved
  } = settings as Record<string, unknown>;
  return {
    ...persistedState,
    settings: {
      ...(version < 2 ? { maxChildRuntimeMs: null } : {}),
      maxConcurrentWork: defaults.maxConcurrentWork,
      maxDepth: defaults.maxDepth,
      maxInvocations: defaults.maxInvocations,
      ...saved,
      ...(saved['maxStepOutputTokens'] === 8192 ? { maxStepOutputTokens: null } : {}),
      ...(saved['synthesisOutputTokens'] === 2048 ? { synthesisOutputTokens: null } : {}),
    },
  };
}

export const useAssistantSubagentPreferencesStore = create<AssistantSubagentPreferencesStore>()(
  persistDurable(
    ASSISTANT_SUBAGENT_PREFERENCES_STORE_NAME,
    (set, get) => {
      const patch = <Field extends keyof RuntimeSubagentSettings>(
        field: Field,
        value: RuntimeSubagentSettings[Field]
      ): void => {
        // Validate the complete next value FIRST; a throw here lands nothing.
        const settings = parseRuntimeSubagentSettings({ ...get().settings, [field]: value });
        set({ settings });
      };
      return {
        ...defaultData(),
        resetToDefaults: () => set(defaultData()),
        setMaxChildRuntimeMs: (value) => patch('maxChildRuntimeMs', value),
        setMaxChildSteps: (value) => patch('maxChildSteps', value),
        setMaxConcurrentWork: (value) => patch('maxConcurrentWork', value),
        setMaxDepth: (value) => patch('maxDepth', value),
        setMaxInvocations: (value) => patch('maxInvocations', value),
        setMaxStepOutputTokens: (value) => patch('maxStepOutputTokens', value),
        setSynthesisOutputTokens: (value) => patch('synthesisOutputTokens', value),
      };
    },
    {
      merge: createSanitizedPersistMerge(sanitizePersistedData),
      migrate: (persistedState, version) =>
        sanitizePersistedData(migratePersistedData(persistedState, version)),
      partialize: (state) => ({ settings: state.settings }),
      version: STORE_VERSION,
    }
  )
);
