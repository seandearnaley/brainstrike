/**
 * Per-child subagent budgets (Settings → Subagents → Subagent budgets).
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
  setMaxChildSteps: (value: number) => void;
  setMaxStepOutputTokens: (value: number) => void;
  setSynthesisOutputTokens: (value: number) => void;
}

export type AssistantSubagentPreferencesStore = AssistantSubagentPreferencesData &
  AssistantSubagentPreferencesActions;

export const ASSISTANT_SUBAGENT_PREFERENCES_STORE_NAME =
  'assistant-subagent-preferences.v1' as const;
const STORE_VERSION = 1 as const;

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

const storage = createJSONStorage(() => createBrowserJsonStorage());

export const useAssistantSubagentPreferencesStore = create<AssistantSubagentPreferencesStore>()(
  persist(
    (set, get) => {
      const patch = (field: keyof RuntimeSubagentSettings, value: number) => {
        // Validate the complete next value FIRST; a throw here lands nothing.
        const settings = parseRuntimeSubagentSettings({ ...get().settings, [field]: value });
        set({ settings });
      };
      return {
        ...defaultData(),
        resetToDefaults: () => set(defaultData()),
        setMaxChildOutputTokens: (value) => patch('maxChildOutputTokens', value),
        setMaxChildSteps: (value) => patch('maxChildSteps', value),
        setMaxStepOutputTokens: (value) => patch('maxStepOutputTokens', value),
        setSynthesisOutputTokens: (value) => patch('synthesisOutputTokens', value),
      };
    },
    {
      merge: createSanitizedPersistMerge(sanitizePersistedData),
      migrate: sanitizePersistedData,
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
