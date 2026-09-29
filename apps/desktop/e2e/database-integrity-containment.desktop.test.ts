import { existsSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';

/**
 * BST-1870: an integrity error is CONTAINED, never answered by replacing the
 * database. Real PGlite, real SQLSTATE, no test seam: a `DO` block raises
 * `XX001` (`data_corrupted`) through the production `db:query` path. The same
 * statement is the manual CDT recipe:
 *
 *   await window.electronAPI.db.query("DO $$ BEGIN RAISE EXCEPTION 'integrity probe'
 *     USING ERRCODE = 'data_corrupted'; END $$")
 */
const INTEGRITY_PROBE_SQL =
  "DO $$ BEGIN RAISE EXCEPTION 'integrity probe' USING ERRCODE = 'data_corrupted'; END $$";

interface RendererDatabaseBridge {
  readonly diagnostics: () => Promise<{ readonly dataDir: string }>;
  readonly query: (
    sql: string,
    params?: readonly unknown[],
    options?: { readonly priority: 'background' | 'foreground' | 'normal' }
  ) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

/** The slice of `window` this test reads, cast through `unknown` because the app augments `Window`. */
interface IntegrityProbeWindow {
  __probe?: number;
  databaseIntegrity?: {
    readonly getState: () => Promise<{
      readonly revision: number;
      readonly state: {
        readonly context?: string;
        readonly kind: string;
        readonly signal?: { readonly sqlstate: string };
      };
    }>;
  };
  electronAPI?: { readonly db?: RendererDatabaseBridge };
}

/** The message of a rejected call. Electron's raw-invoke name formatting is not relied on. */
async function rejectionMessage(
  page: Page,
  call: { readonly options?: { readonly priority: 'background' }; readonly sql: string }
): Promise<string> {
  return await page.evaluate(async ({ options, sql }) => {
    const db = (window as unknown as IntegrityProbeWindow).electronAPI?.db;
    if (!db) {
      throw new Error('Electron db bridge is not available');
    }
    try {
      await db.query(sql, [], options);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error(`Expected the call to reject: ${sql}`);
  }, call);
}

async function countFileRecords(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    const db = (window as unknown as IntegrityProbeWindow).electronAPI?.db;
    if (!db) {
      throw new Error('Electron db bridge is not available');
    }
    const result = await db.query('SELECT COUNT(*)::int AS count FROM file_records');
    return Number(result.rows[0]?.['count']);
  });
}

test.describe('Database integrity containment (desktop) @desktop-db-storage', () => {
  test('contains an integrity error without replacing the database or reloading', async ({
    electron,
    window: page,
  }) => {
    try {
      await page.evaluate(() => {
        (window as unknown as IntegrityProbeWindow).__probe = 1;
      });
      const recordsBefore = await countFileRecords(page);

      // The corrupt-page error rejects with its own truthful copy.
      const message = await rejectionMessage(page, { sql: INTEGRITY_PROBE_SQL });
      expect(message).toContain('SQLSTATE XX001');
      expect(message).toContain('Nothing was deleted or replaced');

      // The state is contained under the entry point that hit it.
      const snapshot = await page.evaluate(async () => {
        const bridge = (window as unknown as IntegrityProbeWindow).databaseIntegrity;
        if (!bridge) {
          throw new Error('window.databaseIntegrity is not available');
        }
        return await bridge.getState();
      });
      expect(snapshot.state).toMatchObject({
        context: 'db:query',
        kind: 'contained',
        signal: { sqlstate: 'XX001' },
      });

      // Foreground work goes on; background work is paused and never reaches the database.
      const foreground = await page.evaluate(async () => {
        const db = (window as unknown as IntegrityProbeWindow).electronAPI?.db;
        if (!db) {
          throw new Error('Electron db bridge is not available');
        }
        return await db.query('SELECT 1 AS one');
      });
      expect(foreground.rows).toEqual([{ one: 1 }]);
      const paused = await rejectionMessage(page, {
        options: { priority: 'background' },
        sql: 'SELECT 1',
      });
      expect(paused).toContain('Background database work is paused');
      expect(paused).toContain('Nothing was deleted or replaced');

      // Nothing was replaced: the data is intact, the page never reloaded, the directory remains.
      expect(await countFileRecords(page)).toBe(recordsBefore);
      expect(await page.evaluate(() => (window as unknown as IntegrityProbeWindow).__probe)).toBe(
        1
      );
      const dataDir = await page.evaluate(async () => {
        const db = (window as unknown as IntegrityProbeWindow).electronAPI?.db;
        if (!db) {
          throw new Error('Electron db bridge is not available');
        }
        return (await db.diagnostics()).dataDir;
      });
      expect(existsSync(dataDir)).toBe(true);
    } finally {
      // A contained process must not be inherited by any other test.
      await electron.dispose();
    }
  });
});
