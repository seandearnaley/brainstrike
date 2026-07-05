/**
 * Fail-closed gate for browser Turso chunk persistence (A7 ship decision,
 * 2026-07-05).
 *
 * `@tursodatabase/database-wasm` (0.6.1 AND 0.7.0-pre.17) has a
 * data-dependent indexed-insert lockup: transactions writing indexed rows
 * (the gram sidecars' PK/secondary btrees) can hang MID-STATEMENT with no
 * error, wedging the connection. The trigger is a page-state/key-set
 * coincidence, not volume — real-world chunk contents trip it routinely
 * while tiny fixtures pass. The native engine commits the identical
 * statement stream in milliseconds, no pragma workaround exists
 * (`wal_autocheckpoint` is not a valid pragma in the wasm build;
 * `wal_checkpoint` is unrelated), and batch-size/statement-shape changes do
 * not help. See the migration ledger finding "Browser WASM Indexed-Insert
 * Lockup (2026-07-05)".
 *
 * REGRESSION TRIGGER / RE-ENABLE CHECKLIST — flip
 * `BROWSER_TURSO_CHUNK_INDEXING_ENABLED` to `true` only when a fixed
 * `@tursodatabase/database-wasm` release lands, then:
 *   1. the gated success-path tests in
 *      packages/db/__tests__/db-provider-turso-browser.test.tsx take over
 *      from the fail-closed tests automatically,
 *   2. flip `WEB_TURSO_CHUNK_INDEXING_BLOCKED` in
 *      apps/web/e2e/utils/turso-gates.ts so the full import/backfill web
 *      E2E specs run again on the Turso default (they are the real-engine
 *      regression proof),
 *   3. update the ledger finding with the fixed version.
 */
export const BROWSER_TURSO_CHUNK_INDEXING_ENABLED = false;

export function isBrowserTursoChunkIndexingEnabled(): boolean {
  return BROWSER_TURSO_CHUNK_INDEXING_ENABLED;
}

export const BROWSER_TURSO_CHUNK_INDEXING_BLOCKED_CODE =
  'browser_turso_chunk_indexing_blocked' as const;

export const BROWSER_TURSO_CHUNK_INDEXING_BLOCKED_MESSAGE =
  'Browser Turso chunked indexing is blocked by a @tursodatabase/database-wasm ' +
  'indexed-insert lockup (statements hang mid-transaction with no error; also ' +
  'present in 0.7.0-pre.17). See the migration ledger finding "Browser WASM ' +
  'Indexed-Insert Lockup (2026-07-05)". Use VITE_BRAINSTRIKE_DB_RUNTIME=pglite ' +
  'for web indexing until the vendor fix.';

export class BrowserTursoChunkIndexingBlockedError extends Error {
  readonly code = BROWSER_TURSO_CHUNK_INDEXING_BLOCKED_CODE;

  constructor() {
    super(BROWSER_TURSO_CHUNK_INDEXING_BLOCKED_MESSAGE);
    this.name = 'BrowserTursoChunkIndexingBlockedError';
  }
}

export function isBrowserTursoChunkIndexingBlockedError(
  error: unknown
): error is BrowserTursoChunkIndexingBlockedError {
  return (
    error instanceof BrowserTursoChunkIndexingBlockedError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === BROWSER_TURSO_CHUNK_INDEXING_BLOCKED_CODE)
  );
}

/**
 * Throws the typed vendor diagnostic while the gate is closed. Called at the
 * browser Turso chunk-persistence seams (the provider's atomic enqueue and
 * chunk-insert surfaces) BEFORE any statement is issued, so no consumer can
 * reach the hanging indexed insert.
 */
export function assertBrowserTursoChunkIndexingEnabled(): void {
  if (!isBrowserTursoChunkIndexingEnabled()) {
    throw new BrowserTursoChunkIndexingBlockedError();
  }
}
