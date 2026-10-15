/**
 * Agent Skills preferences (SKILL.md skills discovered from `.brainstrike/skills`
 * + `.claude/skills` across mounted roots and the home dir — see
 * docs/agents/workspace-context.md § "Instructions, prompts and skills").
 *
 * - `masterEnabled` — top-level opt-out for the whole feature. Defaults ON
 *   (matching Claude Code's baseline: installed skills are available). When
 *   OFF, no skills are scanned, injected, or offered. PERSISTED.
 * - `disabledSkillKeys` — per-skill disables keyed by the DURABLE preference
 *   key (`root:<roots.id>:<name>` / `global:<name>` — never a raw path; see
 *   `deriveSkillPreferenceKey` in assistant-contract). Only `true` entries are
 *   stored — re-enabling deletes the key, so the map never accumulates stale
 *   `false` residue. PERSISTED.
 *
 * Deliberately holds state only: scanning + engine construction live in the
 * desktop assistant server (`request-skills.ts`); the renderer attaches the
 * derived wire snapshot ({@link buildSkillsContextRequest}) to the request as
 * `runtimeData.skillsPreference` — a preference that can only REDUCE the skill
 * set, never inject.
 *
 * Factory reset: the persisted slice is wiped by `clearPersistentUiState`'s
 * blanket `localStorage.clear()`, and the live store is reset explicitly via
 * {@link resetSkillsPreferencesStoreToDefaults}, which `clearPersistentUiState`
 * invokes (mirrors `workspace-instructions-preferences-store`; FACTORY RESET
 * CONTRACT).
 */

import type { SkillsContextRequest } from '@brainstrike/assistant-contract';
import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge';

interface SkillsPreferencesData {
  /**
   * Per-skill disables keyed by the durable preference key. Only `true`
   * entries are stored. PERSISTED.
   */
  disabledSkillKeys: Record<string, boolean>;
  /** Master opt-out switch for the whole feature. Defaults ON. PERSISTED. */
  masterEnabled: boolean;
}

interface SkillsPreferencesActions {
  resetToDefaults: () => void;
  setMasterEnabled: (enabled: boolean) => void;
  setSkillDisabled: (preferenceKey: string, disabled: boolean) => void;
}

export type SkillsPreferencesStore = SkillsPreferencesData & SkillsPreferencesActions;

const STORE_NAME = 'skills-preferences.v1' as const;
const STORE_VERSION = 1 as const;

function defaultData(): SkillsPreferencesData {
  return {
    disabledSkillKeys: {},
    masterEnabled: true,
  };
}

/**
 * Coerce an unknown persisted disable map into a record of ONLY well-typed
 * `true` entries — a malformed payload cannot disable (or half-disable)
 * anything by accident.
 */
function sanitizeDisabledKeys(value: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (!value || typeof value !== 'object') {
    return result;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === true && key.length > 0) {
      result[key] = true;
    }
  }
  return result;
}

function sanitizePersistedData(persistedState: unknown): SkillsPreferencesData {
  const candidate =
    persistedState && typeof persistedState === 'object'
      ? (persistedState as Partial<SkillsPreferencesData>)
      : {};
  return {
    disabledSkillKeys: sanitizeDisabledKeys(candidate.disabledSkillKeys),
    // A malformed master flag falls back to the ON default (feature enabled).
    masterEnabled: typeof candidate.masterEnabled === 'boolean' ? candidate.masterEnabled : true,
  };
}

const storage = createJSONStorage(() => createBrowserJsonStorage());

export const useSkillsPreferencesStore = create<SkillsPreferencesStore>()(
  persist(
    (set) => ({
      ...defaultData(),
      resetToDefaults: () => set(defaultData()),
      setMasterEnabled: (enabled) => set({ masterEnabled: enabled }),
      setSkillDisabled: (preferenceKey, disabled) =>
        set((state) => {
          const next = { ...state.disabledSkillKeys };
          if (disabled && preferenceKey.length > 0) {
            next[preferenceKey] = true;
          } else {
            delete next[preferenceKey];
          }
          return { disabledSkillKeys: next };
        }),
    }),
    {
      merge: createSanitizedPersistMerge<SkillsPreferencesStore, SkillsPreferencesData>(
        sanitizePersistedData
      ),
      migrate: sanitizePersistedData,
      name: STORE_NAME,
      partialize: (state) => ({
        disabledSkillKeys: state.disabledSkillKeys,
        masterEnabled: state.masterEnabled,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);

export const skillsPreferencesSelectors = {
  disabledSkillKeys: (store: SkillsPreferencesStore): Record<string, boolean> =>
    store.disabledSkillKeys,
  masterEnabled: (store: SkillsPreferencesStore): boolean => store.masterEnabled,
};

/**
 * Derive the serializable request snapshot (`runtimeData.skillsPreference`).
 * Defensive against an invalid caller-provided snapshot: a non-object disable
 * map derives as empty rather than throwing in a render path. Persisted state is
 * sanitized during every hydration; the server-side strict parse remains the
 * honest gate.
 */
export function buildSkillsContextRequest(
  state: Pick<SkillsPreferencesStore, 'disabledSkillKeys' | 'masterEnabled'>
): SkillsContextRequest {
  const disabled = state.disabledSkillKeys;
  return {
    disabledSkillKeys:
      disabled && typeof disabled === 'object' && !Array.isArray(disabled)
        ? Object.keys(disabled)
        : [],
    masterEnabled: state.masterEnabled === true,
  };
}

/**
 * Resets the live store to defaults AND clears its persisted slice. Invoked by
 * the factory-reset pipeline (FACTORY RESET CONTRACT).
 */
export function resetSkillsPreferencesStoreToDefaults(): void {
  try {
    const persistApi = (
      useSkillsPreferencesStore as typeof useSkillsPreferencesStore & {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Best effort: storage errors must not block the reset of in-memory state.
  }
  useSkillsPreferencesStore.setState(defaultData());
}

/** Test-only reset helper. */
export function __resetSkillsPreferencesStoreForTests(): void {
  resetSkillsPreferencesStoreToDefaults();
}
