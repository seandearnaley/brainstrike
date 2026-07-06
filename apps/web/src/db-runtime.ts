import {
  type BrainstrikeDbRuntimeSelection,
  DEFAULT_BROWSER_TURSO_WASM_DB_PATH,
  getDefaultBrowserPGliteDataDir,
  resolveBrainstrikeDbRuntimeSelection,
} from '@brainstrike/db';

/**
 * Boot-time web DB runtime resolution (A7 browser cutover, 2026-07-05).
 *
 * The web app resolves its runtime selection ONCE at boot through the shared
 * runtime-selection seam, mirroring desktop semantics: an unset
 * `VITE_BRAINSTRIKE_DB_RUNTIME` defaults to Turso browser WASM, and explicit
 * `VITE_BRAINSTRIKE_DB_RUNTIME=pglite` is the only opt-out (the DR-5
 * comparison oracle until workstream D retires PGlite). Because resolution is
 * boot-time and reads nothing persisted, a factory reset can never pin the
 * next boot back to PGlite — the fresh default is always Turso.
 *
 * Strict parse, no silent fallbacks: an unset or blank env value uses the
 * platform default; any present-but-malformed value THROWS through
 * `resolveBrainstrikeDbRuntimeSelection` (mirrors how
 * `BRAINSTRIKE_TOOL_TIMEOUT_MS` is strict-parsed in
 * packages/agent/src/config/resilience-config.ts and how desktop parses
 * `BRAINSTRIKE_DB_RUNTIME` in apps/desktop/src/db-main.ts).
 */
export function resolveWebDbRuntimeSelection(
  rawEnvValue: string | undefined
): BrainstrikeDbRuntimeSelection {
  const requestedEngine = rawEnvValue?.trim();
  if (requestedEngine === undefined || requestedEngine === '') {
    return resolveBrainstrikeDbRuntimeSelection({ platform: 'web' });
  }
  return resolveBrainstrikeDbRuntimeSelection({
    platform: 'web',
    requestedEngine,
    source: 'env',
  });
}

const E2E_DB_PATH_SESSION_KEY = 'brainstrike.e2e.dbPath.v1';

/**
 * PGlite e2e path is intentionally NOT engine-versioned (no `-pg<N>`): each
 * Playwright session mints a fresh UUID and a CI run pins a single engine, so
 * an e2e store never has to be opened across engine majors. Trade-off: because
 * the base name doesn't end in `-pg<N>`, `reclaimLegacyBrowserPGliteStorage`
 * will NOT sweep abandoned `web-e2e-*` stores; they're reclaimed only by
 * factory-reset enumeration.
 */
const PGLITE_E2E_DB_PATH_PREFIX = 'idb://web-e2e-';

/**
 * Turso e2e stores are plain OPFS file names (the browser Turso store never
 * uses idb:// URLs). Each Playwright session mints a fresh UUID so parallel
 * workers and successive sessions never contend for the same OPFS
 * single-writer access handle.
 */
const TURSO_E2E_DB_PATH_PREFIX = 'web-e2e-turso-';

function createE2eDbPath(engine: BrainstrikeDbRuntimeSelection['engine']): string {
  if (typeof window.crypto?.randomUUID !== 'function') {
    throw new Error('Playwright web E2E database isolation requires crypto.randomUUID');
  }
  const uuid = window.crypto.randomUUID();
  return engine === 'turso'
    ? `${TURSO_E2E_DB_PATH_PREFIX}${uuid}.db`
    : `${PGLITE_E2E_DB_PATH_PREFIX}${uuid}`;
}

function e2eDbPathPrefixForEngine(engine: BrainstrikeDbRuntimeSelection['engine']): string {
  return engine === 'turso' ? TURSO_E2E_DB_PATH_PREFIX : PGLITE_E2E_DB_PATH_PREFIX;
}

/**
 * Runtime-aware web DB path. Defaults: the engine-versioned PGlite
 * IndexedDB directory (`idb://web-pg18`) for the PGlite opt-out, the default
 * OPFS store file for Turso. Under Playwright automation each session mints
 * an isolated per-UUID store; a sessionStorage value from a different engine
 * (prefix mismatch) is discarded so an engine switch can never reuse the
 * other runtime's path.
 */
export function resolveWebDbPath(engine: BrainstrikeDbRuntimeSelection['engine']): string {
  if (window.navigator.webdriver !== true) {
    return engine === 'turso'
      ? DEFAULT_BROWSER_TURSO_WASM_DB_PATH
      : getDefaultBrowserPGliteDataDir('web');
  }

  const existingPath = window.sessionStorage.getItem(E2E_DB_PATH_SESSION_KEY);
  if (existingPath?.startsWith(e2eDbPathPrefixForEngine(engine))) {
    return existingPath;
  }

  const dbPath = createE2eDbPath(engine);
  window.sessionStorage.setItem(E2E_DB_PATH_SESSION_KEY, dbPath);
  return dbPath;
}
