// @vitest-environment jsdom
/**
 * Registry ↔ call-site parity for the reset-table registry (BST-992).
 *
 * `clear-data.test.tsx` / `factory-reset.test.tsx` / the integration suites
 * deliberately pin TEST-OWNED literals so production and test cannot drift
 * together. This file is the OTHER instrument in the triangulation: it imports
 * the production registry on purpose and asserts each renderer reset path
 * clears exactly the registry set, so a table added to the registry without a
 * call site (or a call site outside the registry) fails here, while a
 * registry+call-site drift from reality still fails the test-owned fixtures
 * and the information_schema sweep in
 * `reset-table-coverage.integration.test.ts`.
 */
import type { PGlite } from '@electric-sql/pglite';
import { act, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbProvider } from '../src/db-provider';
import * as migrations from '../src/migrations/bootstrap';
import {
  auditResetTableCoverage,
  getFactoryResetOnlyTables,
  getFactoryResetTables,
  getMastraResetTables,
  getResetTables,
  RESET_EXCLUDED_TABLES,
} from '../src/reset-table-registry';
import { useClearAllData, useFactoryReset, useFileRecordRepository } from '../src/use-db';
import * as wasmLoaderModule from '../src/wasm-loader';

function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath="memory://">{children}</DbProvider>;
}

type QueryMock = Mock<(sql: string) => Promise<{ rows: unknown[] }>>;

/**
 * Dispatch-by-SQL stub that answers every `to_regclass` probe "present" and
 * records the table name of every DELETE, so the recorded set is exactly the
 * set of relations the path under test empties (probe-cleared AND bare-deleted
 * alike).
 */
function createRecordingQueryMock(cleared: Set<string>): QueryMock {
  return vi.fn(async (sql: string) => {
    if (sql === migrations.PGVECTOR_EXTENSION_PRESENCE_QUERY) {
      return { rows: [{ '?column?': 1 }] };
    }
    const counted = sql.match(/^SELECT COUNT\(\*\) as count FROM (\w+)$/u);
    if (counted) {
      return { rows: [{ count: '0' }] };
    }
    const probed = sql.match(/^SELECT to_regclass\('([^']+)'\)/u);
    if (probed) {
      return { rows: [{ present: true }] };
    }
    const deleted = sql.match(/^DELETE FROM (\w+)$/u);
    if (deleted) {
      cleared.add(deleted[1] as string);
    }
    return { rows: [] };
  });
}

describe('reset-table registry', () => {
  it('holds 42 unique relations and never contradicts the exclusion ledger', () => {
    const tables = getResetTables();
    expect(tables).toHaveLength(42);
    expect(new Set(tables).size).toBe(42);
    // The Mastra six are part of the set, sourced from the canonical exports.
    for (const table of getMastraResetTables()) {
      expect(tables).toContain(table);
    }
    // A name in BOTH ledgers would make "clear it" and "it survives" true at
    // once; the audit reports that as doubleRegistered.
    expect(auditResetTableCoverage([...tables]).doubleRegistered).toEqual([]);
    // The factory-reset-only family (BST-992 convergence): six seed-free
    // relations, disjoint from both other ledgers, wiped by purgeTablesTx
    // on top of the clear set.
    expect(getFactoryResetOnlyTables()).toHaveLength(6);
    expect(getFactoryResetTables()).toHaveLength(48);
    expect(new Set(getFactoryResetTables()).size).toBe(48);
  });

  // Control tests: an instrument that cannot fail is not evidence. Prove BOTH
  // halves of the audit flag fabricated drift before trusting its green in the
  // integration sweep — `doubleRegistered` needs injected ledgers, because
  // against the real (disjoint) constants no input could ever trip it.
  it('audit flags an unregistered table and a double-registered name', () => {
    expect(auditResetTableCoverage(['brand_new_unregistered_table']).unregistered).toEqual([
      'brand_new_unregistered_table',
    ]);
    expect(auditResetTableCoverage([...getResetTables()]).unregistered).toEqual([]);
    expect(auditResetTableCoverage(Object.keys(RESET_EXCLUDED_TABLES)).unregistered).toEqual([]);
    expect(
      auditResetTableCoverage([], { excluded: ['roots'], reset: ['roots'] }).doubleRegistered
    ).toEqual(['roots']);
    expect(
      auditResetTableCoverage([], {
        excluded: ['token_cache'],
        factoryResetOnly: ['token_cache'],
        reset: [],
      }).doubleRegistered
    ).toEqual(['token_cache']);
  });

  describe('renderer call-site parity', () => {
    let cleared: Set<string>;

    beforeEach(() => {
      cleared = new Set<string>();
      const query = createRecordingQueryMock(cleared);
      const mockDb = {
        close: vi.fn(async () => undefined),
        exec: vi.fn(async () => undefined),
        query,
        transaction: vi.fn(
          async (callback: (tx: { query: QueryMock }) => Promise<unknown> | unknown) =>
            await callback({ query })
        ),
      };
      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(
        mockDb as unknown as PGlite
      );
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('clearViaPGlite clears exactly the registry set', async () => {
      const { result } = renderHook(
        () => ({ clearData: useClearAllData(), repo: useFileRecordRepository() }),
        { wrapper }
      );
      await waitFor(() => {
        expect(result.current.repo).not.toBeNull();
        expect(result.current.clearData).not.toBeNull();
      });

      await result.current.clearData?.();
      expect([...cleared].sort()).toEqual([...getResetTables()].sort());
    });

    it('purgeTablesTx clears exactly the registry set', async () => {
      const { result } = renderHook(
        () => ({ repo: useFileRecordRepository(), reset: useFactoryReset() }),
        { wrapper }
      );
      await waitFor(() => {
        expect(result.current.repo).not.toBeNull();
        expect(result.current.reset).not.toBeNull();
      });

      await act(async () => {
        await result.current.reset?.();
      });
      // Factory reset wipes the clear set PLUS the six factory-reset-only
      // relations (BST-992 convergence).
      expect([...cleared].sort()).toEqual([...getFactoryResetTables()].sort());
    });
  });
});
