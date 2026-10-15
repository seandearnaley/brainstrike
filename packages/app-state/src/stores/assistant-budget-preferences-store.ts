/**
 * Assistant budget guardrail preferences (Task Ledger phase 1 — see
 * docs/agents/assistant-persistence.md § "Memory and accounting" → Budget guardrails).
 *
 * - `dailyCapUsd` — rolling LAST-24H spend cap in USD. `null` = off (default).
 *   When the derived last-24h spend reaches the cap, the composer blocks new
 *   sends with a visible notice and an explicit per-session override. PERSISTED.
 * - `perRunCapUsd` — per-run cost cap in USD. `null` = off (default). Display
 *   only: the Task Ledger panel flags runs whose exact-or-priced cost exceeds
 *   it. PERSISTED.
 *
 * Validation is STRICT on set: a cap must be a finite number > 0 or `null`;
 * anything else THROWS (no silent coercion — see AGENTS.md). Persisted
 * hydration sanitizes unknown payloads back to the null default.
 *
 * Factory reset: the persisted slice is wiped by `clearPersistentUiState`'s
 * blanket `localStorage.clear()` and the live store is reset explicitly via
 * `resetAssistantBudgetPreferencesStoreToDefaults`, which
 * `clearPersistentUiState` invokes (FACTORY RESET CONTRACT).
 */

import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge';

interface AssistantBudgetPreferencesData {
  /** Rolling last-24h spend cap in USD; null = off. PERSISTED. */
  dailyCapUsd: number | null;
  /** Per-run cost cap in USD (ledger display flag); null = off. PERSISTED. */
  perRunCapUsd: number | null;
}

interface AssistantBudgetPreferencesActions {
  resetToDefaults: () => void;
  setDailyCapUsd: (capUsd: number | null) => void;
  setPerRunCapUsd: (capUsd: number | null) => void;
}

export type AssistantBudgetPreferencesStore = AssistantBudgetPreferencesData &
  AssistantBudgetPreferencesActions;

const STORE_NAME = 'assistant-budget-preferences.v1' as const;
const STORE_VERSION = 1 as const;

function defaultData(): AssistantBudgetPreferencesData {
  return {
    dailyCapUsd: null,
    perRunCapUsd: null,
  };
}

/**
 * A cap is either `null` (off) or a finite USD amount > 0. Anything else
 * THROWS — settings UIs must validate before writing, never rely on coercion.
 */
function assertValidCapUsd(value: number | null, fieldName: string): void {
  if (value === null) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${fieldName} must be a finite USD amount greater than 0, or null to turn the cap off (received ${String(value)}).`
    );
  }
}

/** Persisted-payload sanitizer: invalid → null (cap off). */
function sanitizeCapUsd(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

const storage = createJSONStorage(() => createBrowserJsonStorage());

function sanitizePersistedData(persistedState: unknown): AssistantBudgetPreferencesData {
  if (!(persistedState && typeof persistedState === 'object')) {
    return defaultData();
  }
  const candidate = persistedState as Partial<AssistantBudgetPreferencesData>;
  return {
    dailyCapUsd: sanitizeCapUsd(candidate.dailyCapUsd),
    perRunCapUsd: sanitizeCapUsd(candidate.perRunCapUsd),
  };
}

export const useAssistantBudgetPreferencesStore = create<AssistantBudgetPreferencesStore>()(
  persist(
    (set) => ({
      ...defaultData(),
      resetToDefaults: () => set(defaultData()),
      setDailyCapUsd: (capUsd) => {
        assertValidCapUsd(capUsd, 'dailyCapUsd');
        set({ dailyCapUsd: capUsd });
      },
      setPerRunCapUsd: (capUsd) => {
        assertValidCapUsd(capUsd, 'perRunCapUsd');
        set({ perRunCapUsd: capUsd });
      },
    }),
    {
      merge: createSanitizedPersistMerge(sanitizePersistedData),
      migrate: sanitizePersistedData,
      name: STORE_NAME,
      partialize: (state) => ({
        dailyCapUsd: state.dailyCapUsd,
        perRunCapUsd: state.perRunCapUsd,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);

/**
 * Resets the live store to defaults AND clears its persisted slice. Invoked by
 * the factory-reset pipeline (FACTORY RESET CONTRACT).
 */
export function resetAssistantBudgetPreferencesStoreToDefaults(): void {
  try {
    const persistApi = (
      useAssistantBudgetPreferencesStore as typeof useAssistantBudgetPreferencesStore & {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Best effort: storage errors must not block the reset of in-memory state.
  }
  useAssistantBudgetPreferencesStore.setState(defaultData());
}

/** Test-only reset helper. */
export function __resetAssistantBudgetPreferencesStoreForTests(): void {
  resetAssistantBudgetPreferencesStoreToDefaults();
}
