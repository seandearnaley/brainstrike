import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetDiagnosticsRetentionStoreForTests,
  DIAGNOSTICS_RETENTION_DAY_OPTIONS,
  DIAGNOSTICS_RETENTION_ROW_OPTIONS,
  diagnosticsRetentionSelectors,
  useDiagnosticsRetentionStore,
} from '../stores/diagnostics-retention-store.ts';
import type { PersistApi } from './persist-api-test-helper.ts';

const storeWithPersist = useDiagnosticsRetentionStore as PersistApi<
  typeof useDiagnosticsRetentionStore
>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DIAGNOSTIC_RETENTION_MAX_AGE_MS = 30 * MS_PER_DAY;
const DIAGNOSTIC_RETENTION_MAX_ROWS = 20_000;

describe('diagnostics-retention-store', () => {
  beforeEach(() => {
    __resetDiagnosticsRetentionStoreForTests();
  });

  it('defaults maxAgeDays/maxRows to 30 days and 20_000 rows, so behavior is unchanged until edited', () => {
    const state = useDiagnosticsRetentionStore.getState();
    expect(state.maxAgeDays).toBe(DIAGNOSTIC_RETENTION_MAX_AGE_MS / MS_PER_DAY);
    expect(state.maxRows).toBe(DIAGNOSTIC_RETENTION_MAX_ROWS);
    expect(diagnosticsRetentionSelectors.maxAgeDays(state)).toBe(state.maxAgeDays);
    expect(diagnosticsRetentionSelectors.maxRows(state)).toBe(state.maxRows);
  });

  it('updates maxAgeDays and maxRows to any allowed option', () => {
    const store = useDiagnosticsRetentionStore.getState();

    for (const days of DIAGNOSTICS_RETENTION_DAY_OPTIONS) {
      store.setMaxAgeDays(days);
      expect(useDiagnosticsRetentionStore.getState().maxAgeDays).toBe(days);
    }

    for (const rows of DIAGNOSTICS_RETENTION_ROW_OPTIONS) {
      store.setMaxRows(rows);
      expect(useDiagnosticsRetentionStore.getState().maxRows).toBe(rows);
    }
  });

  it('THROWS when maxAgeDays or maxRows is set outside the allowed option lists, instead of coercing', () => {
    const store = useDiagnosticsRetentionStore.getState();

    for (const invalid of [0, 1, 15, 91, -30, Number.NaN]) {
      expect(() => store.setMaxAgeDays(invalid)).toThrow(/maxAgeDays/u);
    }
    for (const invalid of [0, 1, 100, 19_999, -20_000, Number.NaN]) {
      expect(() => store.setMaxRows(invalid)).toThrow(/maxRows/u);
    }

    // A rejected write never lands.
    expect(useDiagnosticsRetentionStore.getState().maxAgeDays).toBe(
      DIAGNOSTIC_RETENTION_MAX_AGE_MS / MS_PER_DAY
    );
    expect(useDiagnosticsRetentionStore.getState().maxRows).toBe(DIAGNOSTIC_RETENTION_MAX_ROWS);
  });

  it('migrate sanitizes a garbage persisted payload back to defaults', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!options?.migrate) {
      throw new Error('persist migrate unavailable for test');
    }

    const migrated = options.migrate({ maxAgeDays: 'forever', maxRows: -1 }, 0) as {
      maxAgeDays: number;
      maxRows: number;
    };

    expect(migrated.maxAgeDays).toBe(DIAGNOSTIC_RETENTION_MAX_AGE_MS / MS_PER_DAY);
    expect(migrated.maxRows).toBe(DIAGNOSTIC_RETENTION_MAX_ROWS);

    const migratedFromNonObject = options.migrate('nope', 0) as {
      maxAgeDays: number;
      maxRows: number;
    };
    expect(migratedFromNonObject.maxAgeDays).toBe(DIAGNOSTIC_RETENTION_MAX_AGE_MS / MS_PER_DAY);
    expect(migratedFromNonObject.maxRows).toBe(DIAGNOSTIC_RETENTION_MAX_ROWS);
  });

  it('sanitizes malformed persisted data at the current version during rehydration', async () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name && storeWithPersist.persist?.rehydrate)) {
      throw new Error('persist storage unavailable for test');
    }

    if (options.version === undefined) {
      throw new Error('persist version unavailable for test');
    }
    options.storage.setItem(options.name, {
      state: { maxAgeDays: 9999, maxRows: -1 },
      version: options.version,
    });

    await storeWithPersist.persist.rehydrate();

    expect(useDiagnosticsRetentionStore.getState().maxAgeDays).toBe(
      DIAGNOSTIC_RETENTION_MAX_AGE_MS / MS_PER_DAY
    );
    expect(useDiagnosticsRetentionStore.getState().maxRows).toBe(DIAGNOSTIC_RETENTION_MAX_ROWS);
  });
});
