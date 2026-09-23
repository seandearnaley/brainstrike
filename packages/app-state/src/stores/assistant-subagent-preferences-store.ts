/**
 * Per-child subagent budgets (Settings → Models → Subagents).
 *
 * `settings` is a complete `RuntimeSubagentSettings`; every setter validates
 * the WHOLE next value through the contract parser, so a field that would
 * violate a range or a cross-field rule THROWS and nothing lands (no silent
 * coercion — AGENTS.md). Persisted hydration sanitizes an invalid payload back
 * to the defaults. Sent to the host as `runtimeData.subagentSettings`.
 *
 * Factory reset: persisted slice wiped by `clearPersistentUiState`, live store
 * reset via `resetAssistantSubagentPreferencesStoreToDefaults` (FACTORY RESET
 * CONTRACT, docs/agents/platform-contracts.md).
 */

import {
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  parseRuntimeSubagentSettings,
  type RuntimeSubagentSettings,
  runtimeSubagentSettingsSchema,
} from '@brainstrike/assistant-contract/subagent-settings';
import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge';

interface AssistantSubagentPreferencesData {
  settings: RuntimeSubagentSettings;
}

interface AssistantSubagentPreferencesActions {
  resetToDefaults: () => void;
  setMaxChildOutputTokens: (value: number) => void;
  /** `null` turns the limit Off. */
  setMaxChildRuntimeMs: (value: number | null) => void;
  setMaxChildSteps: (value: number) => void;
  setMaxStepOutputTokens: (value: number) => void;
  setSynthesisOutputTokens: (value: number) => void;
}

export type AssistantSubagentPreferencesStore = AssistantSubagentPreferencesData &
  AssistantSubagentPreferencesActions;

export const ASSISTANT_SUBAGENT_PREFERENCES_STORE_NAME =
  'assistant-subagent-preferences.v1' as const;
const STORE_VERSION = 2 as const;

function defaultData(): AssistantSubagentPreferencesData {
  return { settings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS };
}

/** Persisted-payload sanitizer: anything the contract rejects → defaults. */
function sanitizePersistedData(persistedState: unknown): AssistantSubagentPreferencesData {
  if (!(persistedState && typeof persistedState === 'object')) {
    return defaultData();
  }
  const candidate = (persistedState as { settings?: unknown }).settings;
  const parsed = runtimeSubagentSettingsSchema.safeParse(candidate);
  return parsed.success ? { settings: parsed.data } : defaultData();
}

/**
 * v1 predates `maxChildRuntimeMs`. Its four budgets carry over and the new
 * limit starts Off; without this step the strict schema rejects the v1 shape
 * and the sanitizer silently resets every saved budget to the defaults.
 */
function migratePersistedData(persistedState: unknown, version: number): unknown {
  if (version >= 2 || !(persistedState && typeof persistedState === 'object')) {
    return persistedState;
  }
  const settings = (persistedState as { settings?: unknown }).settings;
  if (!(settings && typeof settings === 'object')) {
    return persistedState;
  }
  return { ...persistedState, settings: { ...settings, maxChildRuntimeMs: null } };
}

const storage = createJSONStorage(() => createBrowserJsonStorage());

export const useAssistantSubagentPreferencesStore = create<AssistantSubagentPreferencesStore>()(
  persist(
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
        setMaxChildOutputTokens: (value) => patch('maxChildOutputTokens', value),
        setMaxChildRuntimeMs: (value) => patch('maxChildRuntimeMs', value),
        setMaxChildSteps: (value) => patch('maxChildSteps', value),
        setMaxStepOutputTokens: (value) => patch('maxStepOutputTokens', value),
        setSynthesisOutputTokens: (value) => patch('synthesisOutputTokens', value),
      };
    },
    {
      merge: createSanitizedPersistMerge(sanitizePersistedData),
      migrate: (persistedState, version) =>
        sanitizePersistedData(migratePersistedData(persistedState, version)),
      name: ASSISTANT_SUBAGENT_PREFERENCES_STORE_NAME,
      partialize: (state) => ({ settings: state.settings }),
      storage,
      version: STORE_VERSION,
    }
  )
);

/** Live reset + persisted slice clear; invoked by the factory-reset pipeline. */
export function resetAssistantSubagentPreferencesStoreToDefaults(): void {
  try {
    const persistApi = (
      useAssistantSubagentPreferencesStore as typeof useAssistantSubagentPreferencesStore & {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Best effort: storage errors must not block the reset of in-memory state.
  }
  useAssistantSubagentPreferencesStore.setState(defaultData());
}

/** Test-only reset helper. */
export function __resetAssistantSubagentPreferencesStoreForTests(): void {
  resetAssistantSubagentPreferencesStoreToDefaults();
}
