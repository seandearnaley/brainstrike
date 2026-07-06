import type { Page } from '@playwright/test';

/**
 * Web E2E mirror of `BROWSER_TURSO_CHUNK_INDEXING_ENABLED` in
 * packages/db/src/turso/browser-chunk-indexing-gate.ts (this constant is its
 * INVERSE). While the @tursodatabase/database-wasm indexed-insert lockup
 * keeps browser Turso chunk persistence fail-closed:
 *   - the full import/backfill specs SKIP on the Turso default (they are the
 *     real-engine regression proof to re-enable), and
 *   - the fail-closed contract spec (database-import-failclosed-turso)
 *     asserts the typed refusal instead.
 * FLIP BOTH CONSTANTS TOGETHER when the vendor fix lands — see the re-enable
 * checklist in the gate module and the migration ledger finding
 * "Browser WASM Indexed-Insert Lockup (2026-07-05)".
 */
export const WEB_TURSO_CHUNK_INDEXING_BLOCKED = true;

export type WebDbRuntimeEngine = 'pglite' | 'turso';

/**
 * Resolves which DB runtime the booted app is running by inspecting the E2E
 * hooks' per-session store path (Turso mints `web-e2e-turso-<uuid>.db`,
 * PGlite mints `idb://web-e2e-<uuid>`). Fails loudly if the hooks never
 * surface — runtime-dependent specs must not silently guess.
 */
export async function resolveWebDbRuntimeEngine(page: Page): Promise<WebDbRuntimeEngine> {
  const dbPathHandle = await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __brainstrikeWebE2ETestHooks__?: { dbPath?: string };
        }
      ).__brainstrikeWebE2ETestHooks__?.dbPath ?? null,
    undefined,
    { timeout: 30_000 }
  );
  const dbPath = (await dbPathHandle.jsonValue()) as string | null;
  await dbPathHandle.dispose();
  if (typeof dbPath !== 'string') {
    throw new Error('Web E2E hooks did not expose a dbPath; cannot classify the DB runtime.');
  }
  if (dbPath.startsWith('web-e2e-turso-')) {
    return 'turso';
  }
  if (dbPath.startsWith('idb://')) {
    return 'pglite';
  }
  throw new Error(`Unrecognized web E2E dbPath shape: ${dbPath}`);
}
