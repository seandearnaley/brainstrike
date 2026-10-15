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
 * Defaults mirror `DIAGNOSTIC_RETENTION_MAX_AGE_MS` (30 days) and
 * `DIAGNOSTIC_RETENTION_MAX_ROWS` (20_000) exported from
 * `packages/db/src/repositories/diagnostic-events-repository.ts`, so behavior
 * is unchanged until a user edits a preference. Hardcoded here rather than
 * imported: `@brainstrike/db`'s package entrypoint is a heavy barrel
 * (PGlite/wasm bindings, migrations, etc.) and this store — like every
 * sibling preference store in this package — must stay light and importable
 * without a database. The link to the repository constants is enforced on
 * the test side instead (see diagnostics-retention-store.test.ts, which
 * imports the real constants and asserts equality) so a future change to
 * either side fails loudly rather than silently drifting.
 *
 * Factory reset: the persisted slice is wiped by `clearPersistentUiState`'s
 * blanket `localStorage.clear()` (see `factory-reset-helpers.ts`), and the
 * live store is reset explicitly via `resetDiagnosticsRetentionStoreToDefaults`,
 * which `clearPersistentUiState` invokes (FACTORY RESET CONTRACT).
 */

import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createSanitizedPersistMerge } from './sanitized-persist-merge';

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

// See the module doc above for why these are hardcoded instead of imported
// from @brainstrike/db: they MUST track DIAGNOSTIC_RETENTION_MAX_AGE_MS
// (30 * 24 * 60 * 60 * 1000 ms = 30 days) and DIAGNOSTIC_RETENTION_MAX_ROWS
// (20_000) in packages/db/src/repositories/diagnostic-events-repository.ts.
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

/**
 * Resets the live store to defaults AND clears its persisted slice. Invoked by
 * the factory-reset pipeline (FACTORY RESET CONTRACT).
 */
export function resetDiagnosticsRetentionStoreToDefaults(): void {
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

/** Test-only reset helper. */
export function __resetDiagnosticsRetentionStoreForTests(): void {
  resetDiagnosticsRetentionStoreToDefaults();
}
