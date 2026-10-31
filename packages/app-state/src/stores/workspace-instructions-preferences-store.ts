/**
 * Workspace instructions context-file preferences (auto-injection of a mounted
 * root's `AGENTS.md`/`AGENT.md`/`CLAUDE.md` into the assistant's system context —
 * see docs/agents/workspace-context.md § "Instructions, prompts and skills").
 *
 * Threshold-hybrid policy (product ruling):
 * - `masterEnabled` — top-level opt-out. Defaults ON: matching Claude Code's
 *   baseline expectation that a workspace's instructions file is injected. When
 *   OFF, no context file is injected for any root. PERSISTED.
 * - `oversizedOptInByRootId` — per-root opt-in for a context file that EXCEEDS
 *   the per-file char budget. A fits-the-budget file is injected by default; an
 *   oversized file is NOT injected unless the user explicitly opts that root in
 *   (the Settings UI shows the file's size + token estimate first). Keyed by the
 *   durable DB `roots.id`, NEVER a raw path. Only `true` entries are stored —
 *   turning an opt-in off deletes its key, so the map never accumulates stale
 *   `false` residue and its mere presence means "inject this oversized file
 *   truncated". PERSISTED.
 *
 * Deliberately holds state only: the actual file scan + injection lives in the
 * desktop assistant server (`workspace-instructions-context.ts`), so this store
 * stays trivially testable and SSR-safe.
 *
 * Factory reset: Main wipes this renderer's storage after replacing the
 * document, so the store never resets itself for it.
 */

import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge.ts';

interface WorkspaceInstructionsPreferencesData {
  /** Master opt-out switch for the whole feature. Defaults ON. PERSISTED. */
  masterEnabled: boolean;
  /**
   * Per-root opt-in to inject an OVERSIZED context file (truncated). Keyed by the
   * durable DB `roots.id`. Only `true` entries are stored. PERSISTED.
   */
  oversizedOptInByRootId: Record<string, boolean>;
}

interface WorkspaceInstructionsPreferencesActions {
  resetToDefaults: () => void;
  setMasterEnabled: (enabled: boolean) => void;
  setOversizedOptIn: (rootId: string, enabled: boolean) => void;
}

export type WorkspaceInstructionsPreferencesStore = WorkspaceInstructionsPreferencesData &
  WorkspaceInstructionsPreferencesActions;

const STORE_NAME = 'workspace-instructions-preferences.v1' as const;
const STORE_VERSION = 1 as const;

function defaultData(): WorkspaceInstructionsPreferencesData {
  return {
    masterEnabled: true,
    oversizedOptInByRootId: {},
  };
}

/**
 * Coerce an unknown persisted opt-in map into a record of ONLY well-typed `true`
 * entries. Non-boolean or `false` values are dropped so a malformed payload
 * cannot inject an oversized file by accident.
 */
function sanitizeOptIns(value: unknown): Record<string, boolean> {
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

function sanitizePersistedData(persistedState: unknown): WorkspaceInstructionsPreferencesData {
  const candidate =
    persistedState && typeof persistedState === 'object'
      ? (persistedState as Partial<WorkspaceInstructionsPreferencesData>)
      : {};
  return {
    // A malformed master flag falls back to the ON default (feature enabled).
    masterEnabled: typeof candidate.masterEnabled === 'boolean' ? candidate.masterEnabled : true,
    oversizedOptInByRootId: sanitizeOptIns(candidate.oversizedOptInByRootId),
  };
}

const storage = createJSONStorage(() => createBrowserJsonStorage());

export const useWorkspaceInstructionsPreferencesStore =
  create<WorkspaceInstructionsPreferencesStore>()(
    persist(
      (set) => ({
        ...defaultData(),
        resetToDefaults: () => set(defaultData()),
        setMasterEnabled: (enabled) => set({ masterEnabled: enabled }),
        setOversizedOptIn: (rootId, enabled) =>
          set((state) => {
            const next = { ...state.oversizedOptInByRootId };
            if (enabled && rootId.length > 0) {
              next[rootId] = true;
            } else {
              delete next[rootId];
            }
            return { oversizedOptInByRootId: next };
          }),
      }),
      {
        merge: createSanitizedPersistMerge<
          WorkspaceInstructionsPreferencesStore,
          WorkspaceInstructionsPreferencesData
        >(sanitizePersistedData),
        migrate: sanitizePersistedData,
        name: STORE_NAME,
        partialize: (state) => ({
          masterEnabled: state.masterEnabled,
          oversizedOptInByRootId: state.oversizedOptInByRootId,
        }),
        storage,
        version: STORE_VERSION,
      }
    )
  );

export const workspaceInstructionsPreferencesSelectors = {
  masterEnabled: (store: WorkspaceInstructionsPreferencesStore): boolean => store.masterEnabled,
  oversizedOptInByRootId: (store: WorkspaceInstructionsPreferencesStore): Record<string, boolean> =>
    store.oversizedOptInByRootId,
};
