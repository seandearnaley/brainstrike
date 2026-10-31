/**
 * Diagnostic-log retention preferences (Flight Recorder P2b — see
 * docs/archive/agent-contract-history/platform-contracts/p2b-diagnostics-stores.md
 * → "Retention" for the repository-side purge this store's values feed).
 *
 * - `maxAgeDays` — how many days of warn+ diagnostic events to keep. PERSISTED.
 * - `maxRows` — how many diagnostic-event rows to keep. PERSISTED.
 *
 * Both fields are constrained to a fixed option list
 * (`DIAGNOSTICS_RETENTION_DAY_OPTIONS` / `DIAGNOSTICS_RETENTION_ROW_OPTIONS`)
 * rather than a free-form number, so the settings UI can render them as a
 * picker and the purge call always runs with a sane bound.
 *
 * Validation is STRICT on set: a value outside the allowed option list
 * THROWS — no silent coercion (AGENTS.md "NO SILENT FALLBACKS"). This is
 * deliberately asymmetric with persisted hydration below, which SANITIZES an
 * unknown/corrupt payload back to the defaults: a programming
 * error calling a setter with a bad value must surface immediately, but a
 * corrupt persisted blob (e.g. from a future/rolled-back app version) must
 * not brick the settings UI on load.
 *
 * Defaults are 30 days and 20_000 rows, so behavior is unchanged until a user
 * edits a preference.
 *
 * Factory reset: Main wipes this renderer's storage after replacing the
 * document, so the store never resets itself for it.
 */

import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge.ts';

export const DIAGNOSTICS_RETENTION_DAY_OPTIONS = [7, 14, 30, 90] as const;
export const DIAGNOSTICS_RETENTION_ROW_OPTIONS = [5000, 20_000, 50_000] as const;

export interface DiagnosticsRetentionData {
  /** Max age in days of diagnostic events to keep. PERSISTED. */
  maxAgeDays: number;
  /** Max diagnostic-event row count to keep. PERSISTED. */
  maxRows: number;
}

interface DiagnosticsRetentionActions {
  resetToDefaults: () => void;
  setMaxAgeDays: (maxAgeDays: number) => void;
  setMaxRows: (maxRows: number) => void;
}

export type DiagnosticsRetentionStore = DiagnosticsRetentionData & DiagnosticsRetentionActions;

const STORE_NAME = 'diagnostics-retention.v1' as const;
const STORE_VERSION = 1 as const;

const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_ROWS = 20_000;

function defaultData(): DiagnosticsRetentionData {
  return {
    maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    maxRows: DEFAULT_MAX_ROWS,
  };
}

function isValidMaxAgeDays(
  value: number
): value is (typeof DIAGNOSTICS_RETENTION_DAY_OPTIONS)[number] {
  return (DIAGNOSTICS_RETENTION_DAY_OPTIONS as readonly number[]).includes(value);
}

function isValidMaxRows(
  value: number
): value is (typeof DIAGNOSTICS_RETENTION_ROW_OPTIONS)[number] {
  return (DIAGNOSTICS_RETENTION_ROW_OPTIONS as readonly number[]).includes(value);
}

/** A retention value must be one of the allowed options. Anything else THROWS. */
function assertValidMaxAgeDays(value: number): void {
  if (!isValidMaxAgeDays(value)) {
    throw new Error(
      `maxAgeDays must be one of ${DIAGNOSTICS_RETENTION_DAY_OPTIONS.join(', ')} (received ${String(value)}).`
    );
  }
}

/** A retention value must be one of the allowed options. Anything else THROWS. */
function assertValidMaxRows(value: number): void {
  if (!isValidMaxRows(value)) {
    throw new Error(
      `maxRows must be one of ${DIAGNOSTICS_RETENTION_ROW_OPTIONS.join(', ')} (received ${String(value)}).`
    );
  }
}

/** Persisted-payload sanitizer: invalid -> default. */
function sanitizeMaxAgeDays(value: unknown): number {
  return typeof value === 'number' && isValidMaxAgeDays(value) ? value : DEFAULT_MAX_AGE_DAYS;
}

/** Persisted-payload sanitizer: invalid -> default. */
function sanitizeMaxRows(value: unknown): number {
  return typeof value === 'number' && isValidMaxRows(value) ? value : DEFAULT_MAX_ROWS;
}

const storage = createJSONStorage(() => createBrowserJsonStorage());

function sanitizePersistedData(persistedState: unknown): DiagnosticsRetentionData {
  if (!(persistedState && typeof persistedState === 'object')) {
    return defaultData();
  }
  const candidate = persistedState as Partial<DiagnosticsRetentionData>;
  return {
    maxAgeDays: sanitizeMaxAgeDays(candidate.maxAgeDays),
    maxRows: sanitizeMaxRows(candidate.maxRows),
  };
}

export const useDiagnosticsRetentionStore = create<DiagnosticsRetentionStore>()(
  persist(
    (set) => ({
      ...defaultData(),
      resetToDefaults: () => set(defaultData()),
      setMaxAgeDays: (maxAgeDays) => {
        assertValidMaxAgeDays(maxAgeDays);
        set({ maxAgeDays });
      },
      setMaxRows: (maxRows) => {
        assertValidMaxRows(maxRows);
        set({ maxRows });
      },
    }),
    {
      merge: createSanitizedPersistMerge(sanitizePersistedData),
      migrate: sanitizePersistedData,
      name: STORE_NAME,
      partialize: (state) => ({
        maxAgeDays: state.maxAgeDays,
        maxRows: state.maxRows,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);

export const diagnosticsRetentionSelectors = {
  maxAgeDays: (store: DiagnosticsRetentionStore): number => store.maxAgeDays,
  maxRows: (store: DiagnosticsRetentionStore): number => store.maxRows,
};

/** Test-only reset helper. */
export function __resetDiagnosticsRetentionStoreForTests(): void {
  try {
    const persistApi = (
      useDiagnosticsRetentionStore as typeof useDiagnosticsRetentionStore & {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Best effort: storage errors must not block the reset of in-memory state.
  }
  useDiagnosticsRetentionStore.setState(defaultData());
}
