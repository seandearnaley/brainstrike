/**
 * Experiment-assignment preference (BST-1251, recursive self-improvement
 * phase 2B enrollment plumbing).
 *
 * Carries the renderer's per-profile experiment enrollment: an experiment id
 * plus variant label (e.g. `search-policy-v1` / `control`). Both default null
 * (= un-enrolled). The desktop assistant server records the pair verbatim on
 * every run's treatment row (BST-1250); it is attribution metadata only and
 * changes no runtime behavior by itself.
 *
 * The wire contract (`ExperimentAssignmentRequest`) requires BOTH fields, so
 * the request is derived through `buildExperimentAssignmentRequest`, which
 * emits the pair only when both are non-empty — a half-filled pair never
 * reaches the wire.
 *
 * Factory reset clears the persisted slice through `localStorage.clear()` and
 * resets the live store explicitly so an enrollment cannot survive a reset
 * without a renderer reload (FACTORY RESET CONTRACT).
 */

import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge';

interface ExperimentAssignmentPreferencesData {
  /** Experiment identifier; null = un-enrolled. PERSISTED. */
  experimentId: string | null;
  /** Variant label within the experiment; null = un-enrolled. PERSISTED. */
  variant: string | null;
}

interface ExperimentAssignmentPreferencesActions {
  resetToDefaults: () => void;
  setExperimentId: (experimentId: string | null) => void;
  setVariant: (variant: string | null) => void;
}

export type ExperimentAssignmentPreferencesStore = ExperimentAssignmentPreferencesData &
  ExperimentAssignmentPreferencesActions;

const STORE_NAME = 'experiment-assignment-preferences.v1' as const;
const STORE_VERSION = 1 as const;

function defaultData(): ExperimentAssignmentPreferencesData {
  return { experimentId: null, variant: null };
}

function normalizeField(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizePersistedData(persistedState: unknown): ExperimentAssignmentPreferencesData {
  if (!(persistedState && typeof persistedState === 'object')) {
    return defaultData();
  }
  const candidate = persistedState as Partial<ExperimentAssignmentPreferencesData>;
  return {
    experimentId: normalizeField(candidate.experimentId),
    variant: normalizeField(candidate.variant),
  };
}

const storage = createJSONStorage(() => createBrowserJsonStorage());

export const useExperimentAssignmentPreferencesStore =
  create<ExperimentAssignmentPreferencesStore>()(
    persist(
      (set) => ({
        ...defaultData(),
        resetToDefaults: () => set(defaultData()),
        setExperimentId: (experimentId) => set({ experimentId: normalizeField(experimentId) }),
        setVariant: (variant) => set({ variant: normalizeField(variant) }),
      }),
      {
        merge: createSanitizedPersistMerge(sanitizePersistedData),
        migrate: sanitizePersistedData,
        name: STORE_NAME,
        partialize: (state) => ({ experimentId: state.experimentId, variant: state.variant }),
        storage,
        version: STORE_VERSION,
      }
    )
  );

/**
 * Build the wire request from the raw pair. The contract requires both fields
 * together, so an incomplete pair yields `undefined` (un-enrolled) rather
 * than a partial object the server would reject as malformed. This is the
 * single home of the atomicity rule — renderers subscribe to the primitive
 * fields and derive the request through here.
 */
export function buildExperimentAssignmentRequest(
  experimentId: string | null,
  variant: string | null
): { experimentId: string; variant: string } | undefined {
  if (experimentId && variant) {
    return { experimentId, variant };
  }
  return;
}

/** Reset the live store and clear its persisted slice for factory reset. */
export function resetExperimentAssignmentPreferencesStoreToDefaults(): void {
  try {
    const persistApi = (
      useExperimentAssignmentPreferencesStore as typeof useExperimentAssignmentPreferencesStore & {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Best effort: storage errors must not block the reset of in-memory state.
  }
  useExperimentAssignmentPreferencesStore.setState(defaultData());
}

/** Test-only reset helper. */
export function __resetExperimentAssignmentPreferencesStoreForTests(): void {
  resetExperimentAssignmentPreferencesStoreToDefaults();
}
