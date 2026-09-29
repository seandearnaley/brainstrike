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
 *
 * A fresh profile holds almost nothing, so "the counts still match" or "the data
 * directory still exists" would also pass after a delete-and-recreate. The proof
 * that nothing was replaced is a row this test writes before the error, in a
 * table the registry classifies as `precious` (`view_filter_presets`: the
 * user-authored filter presets), and finds again, by the id the database
 * generated for it, afterwards. `view_filter_presets` is the simplest precious
 * table the renderer can write: its only required column is `name`, and
 * `filter-presets.desktop.test.ts` already reads it through the same bridge.
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

interface IntegritySnapshot {
  readonly revision: number;
  readonly state: {
    readonly context?: string;
    readonly kind: string;
    readonly signal?: { readonly sqlstate: string };
  };
}

/** The slice of `window` this test reads, cast through `unknown` because the app augments `Window`. */
interface IntegrityProbeWindow {
  __probe?: number;
  databaseIntegrity?: { readonly getState: () => Promise<IntegritySnapshot> };
  electronAPI?: { readonly db?: RendererDatabaseBridge };
}

interface ProbePreset {
  readonly id: string;
  readonly name: string;
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

async function readIntegritySnapshot(page: Page): Promise<IntegritySnapshot> {
  return await page.evaluate(async () => {
    const bridge = (window as unknown as IntegrityProbeWindow).databaseIntegrity;
    if (!bridge) {
      throw new Error('window.databaseIntegrity is not available');
    }
    return await bridge.getState();
  });
}

/** Writes a uniquely named user preset through the FOREGROUND lane and returns the id the database chose. */
async function seedProbePreset(page: Page): Promise<ProbePreset> {
  return await page.evaluate(async () => {
    const db = (window as unknown as IntegrityProbeWindow).electronAPI?.db;
    if (!db) {
      throw new Error('Electron db bridge is not available');
    }
    const name = `integrity-containment-probe-${crypto.randomUUID()}`;
    const result = await db.query(
      'INSERT INTO view_filter_presets (name) VALUES ($1) RETURNING id',
      [name],
      { priority: 'foreground' }
    );
    const id = result.rows[0]?.['id'];
    if (typeof id !== 'string') {
      throw new Error('Expected the seeded preset to return its generated id');
    }
    return { id, name };
  });
}

async function readProbePresets(page: Page, name: string): Promise<readonly ProbePreset[]> {
  return await page.evaluate(async (presetName) => {
    const db = (window as unknown as IntegrityProbeWindow).electronAPI?.db;
    if (!db) {
      throw new Error('Electron db bridge is not available');
    }
    const result = await db.query('SELECT id, name FROM view_filter_presets WHERE name = $1', [
      presetName,
    ]);
    return result.rows.map((row) => ({ id: String(row['id']), name: String(row['name']) }));
  }, name);
}

async function countPresets(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    const db = (window as unknown as IntegrityProbeWindow).electronAPI?.db;
    if (!db) {
      throw new Error('Electron db bridge is not available');
    }
    const result = await db.query('SELECT COUNT(*)::int AS count FROM view_filter_presets');
    return Number(result.rows[0]?.['count']);
  });
}

test.describe('Database integrity containment (desktop) @desktop-db-storage', () => {
  // The `electron` fixture is per test: each test launches its own app with its own
  // userData directory (derived from the test id) and disposes it on teardown, so a
  // contained process cannot reach another test whatever this body does.
  test('contains an integrity error without replacing the database or reloading', async ({
    electron,
    window: page,
  }) => {
    // Registered before the probe and asserted at the end: a reload at ANY point is a failure.
    const documentLoads: string[] = [];
    const mainFrameNavigations: string[] = [];
    page.on('load', () => documentLoads.push(page.url()));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        mainFrameNavigations.push(frame.url());
      }
    });
    await page.evaluate(() => {
      (window as unknown as IntegrityProbeWindow).__probe = 1;
    });

    // Durable evidence, written through the foreground lane while the database is healthy.
    const before = await readIntegritySnapshot(page);
    expect(before.state).toEqual({ kind: 'healthy' });
    const seeded = await seedProbePreset(page);
    expect(await readProbePresets(page, seeded.name)).toEqual([seeded]);
    const presetsBefore = await countPresets(page);
    expect(Number.isInteger(presetsBefore)).toBe(true);
    expect(presetsBefore).toBeGreaterThan(0);

    // The corrupt-page error rejects with its own truthful copy.
    const message = await rejectionMessage(page, { sql: INTEGRITY_PROBE_SQL });
    expect(message).toContain('SQLSTATE XX001');
    expect(message).toContain('Nothing was deleted or replaced');

    // The state moved inside this test: contained, under the entry point that hit it.
    const after = await readIntegritySnapshot(page);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.state).toMatchObject({
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

    // Nothing was replaced: the exact row written before the error is still there,
    // under the id the database generated, and the count around it is unchanged.
    expect(await readProbePresets(page, seeded.name)).toEqual([seeded]);
    expect(await countPresets(page)).toBe(presetsBefore);

    // Nothing reloaded, at any point of the test.
    expect(documentLoads).toEqual([]);
    expect(mainFrameNavigations).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as IntegrityProbeWindow).__probe)).toBe(1);
    const dataDir = await page.evaluate(async () => {
      const db = (window as unknown as IntegrityProbeWindow).electronAPI?.db;
      if (!db) {
        throw new Error('Electron db bridge is not available');
      }
      return (await db.diagnostics()).dataDir;
    });
    expect(existsSync(dataDir)).toBe(true);

    // A contained process still shuts down cleanly. Not in a `finally`: on a failure above the
    // fixture teardown disposes, and `dispose()` is idempotent, so its own assertion cannot mask this one.
    await electron.dispose();
  });
});
