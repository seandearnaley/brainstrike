export type BrowserPGliteStorageBackend = 'idb' | 'opfs-ahp';

export type BrowserPGliteStorageSelectionReason =
  | 'pglite-recommends-indexeddb'
  | 'requested-indexeddb'
  | 'requested-opfs-ahp-supported'
  | 'requested-opfs-ahp-unavailable';

export interface BrowserPGliteStorageSupport {
  readonly hasOpfsDirectory?: boolean;
  readonly hasWorker?: boolean;
  readonly requestedStorage?: BrowserPGliteStorageBackend | null;
}

export interface BrowserPGliteStorageSelection {
  readonly dataDir: string;
  readonly reason: BrowserPGliteStorageSelectionReason;
  readonly storage: BrowserPGliteStorageBackend;
}

const DEFAULT_BROWSER_DB_NAME = 'app';

/**
 * Persistent PGlite data directories are tagged with the embedded Postgres engine
 * major. A PG major upgrade (e.g. 17 -> 18 in PGlite 0.5) changes the on-disk
 * format, so reusing an unversioned directory across majors fails to initialize.
 * Bumping this token forces a clean, greenfield directory per engine major.
 *
 * THIS MUST TRACK THE ENGINE `@electric-sql/pglite` BUNDLES. Bump it whenever the
 * pinned pglite dependency moves to a release shipping a new Postgres major — not
 * just when you "feel like" versioning. If it lags the engine, a fresh install
 * writes a higher `PG_VERSION` than this constant, the desktop guard treats it as
 * "newer", and `reconcileIncompatiblePgDataDir` throws on every boot. The
 * `pglite-engine-major.integration.test.ts` anchor (which opens a real PGlite
 * handle and compares its server-version major to `PGLITE_ENGINE_MAJOR`) fails CI
 * if this drifts, so a forgotten bump is caught before release rather than in the
 * field.
 *
 * WHEN BUMPING THIS (e.g. to 'pg19'):
 * 1. Append the just-superseded versioned name(s) (e.g. `app-pg18`, `web-pg18`)
 *    to `FALLBACK_INDEXED_DB_NAMES` in
 *    packages/preferences/src/settings/system/factory-reset-helpers.ts as
 *    defense-in-depth. Automatic reclaim already covers prior versioned majors on
 *    every browser — enumerating when supported, else via the deterministic
 *    `enumerationUnavailableLegacyNames` candidate set — so this list is the
 *    secondary (user-initiated factory-reset) cleanup path, not the only one.
 * 2. Bump `BUNDLED_PG_MAJOR` in apps/desktop/src/pg-data-version.ts to match.
 *
 * DEPENDENCY-PIN LOCKSTEP (separate axis from this token): `@electric-sql/pglite`
 * and `@electric-sql/pglite-pgvector` MUST be bumped together. pgvector declares
 * an EXACT peer on a single pglite version (0.0.2 → `@electric-sql/pglite: 0.5.1`).
 * The pins live in different sets of package.json files:
 *   - `@electric-sql/pglite` (exact) — runtime `dependencies` in db, embeddings,
 *     vector-management, file-import, token-cache, desktop; a `devDependency` in
 *     agent (only its tests construct a PGlite — prod receives a DB from the caller).
 *   - `@electric-sql/pglite-pgvector` (exact) — runtime `dependencies` in db and
 *     desktop; a `devDependency` in agent (test-only). The remaining packages don't
 *     import the vector extension and correctly omit it.
 * Bumping pglite alone (e.g. to a 0.5.x patch) breaks peer resolution until
 * pgvector ships a matching release — so move both in the same change (every
 * package.json that pins them, including agent's devDependencies). There is no
 * Renovate/Dependabot in this repo to enforce it; this note is the reminder.
 */
export const PGLITE_DATA_DIR_VERSION = 'pg18';

function withEngineVersion(dbName: string): string {
  return `${dbName}-${PGLITE_DATA_DIR_VERSION}`;
}

export function getDefaultBrowserPGliteDataDir(dbName = DEFAULT_BROWSER_DB_NAME): string {
  return `idb://${withEngineVersion(dbName)}`;
}

export function getOpfsAhpBrowserPGliteDataDir(dbName = DEFAULT_BROWSER_DB_NAME): string {
  return `opfs-ahp://${withEngineVersion(dbName)}`;
}

/**
 * Prefix for the throwaway per-Playwright-session web E2E stores. Owned here so
 * the web entry (which mints `idb://web-e2e-<uuid>` paths) and the worker
 * loader (which relaxes durability for them — see
 * `isEphemeralWebE2eDataDir`) can never drift apart.
 */
export const EPHEMERAL_WEB_E2E_DATA_DIR_PREFIX = 'idb://web-e2e-';

/**
 * True for the per-session throwaway web E2E stores. These are discarded when
 * the Playwright context closes, so strict per-statement durability buys
 * nothing and only makes fresh-DB bootstrap (initdb + the full migration
 * suite) take ~50s — past the E2E readiness budget. Real user stores must
 * NEVER relax durability (see the #1111 rationale at the worker options site).
 */
export function isEphemeralWebE2eDataDir(dataDir: string): boolean {
  return dataDir.startsWith(EPHEMERAL_WEB_E2E_DATA_DIR_PREFIX);
}

/**
 * Current embedded Postgres engine major (e.g. 18), parsed from the version token.
 * Exported so an integration test can anchor it to the major actually reported by
 * an opened PGlite handle — closing the loop so this constant (and, via the
 * cross-package drift test, desktop's `BUNDLED_PG_MAJOR`) can't silently fall out
 * of step with the engine `@electric-sql/pglite` bundles.
 */
export const PGLITE_ENGINE_MAJOR = Number(PGLITE_DATA_DIR_VERSION.replace(/^pg/, ''));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a storage name is an OLDER same-base variant safe to reclaim: the
 * unversioned base (the original pre-versioning store) or any `-pg<N>` variant
 * with N strictly less than the current engine major. Matching every *older*
 * major (not just the immediately-previous suffix) keeps reclamation correct
 * across repeated bumps, while the `< current` gate means an older build never
 * background-deletes a NEWER build's `-pg<N+>` data (which a later re-upgrade
 * could still reopen) — reclaim only ever moves forward.
 *
 * DOWNGRADE COROLLARY (accepted permanent leak): because the gate is forward-only,
 * a browser rolled back from a future `-pg19` build to a `-pg18` build never reaps
 * the newer `/pglite/web-pg19` store — it just boots a fresh `web-pg18` and leaves
 * the newer orphan against origin quota. Unlike desktop (which hard-throws on a
 * newer on-disk major), web leaks it silently until a manual factory reset, and on
 * an enumeration-incapable browser (Safari/Firefox) even factory reset can't clear
 * it, since `FALLBACK_INDEXED_DB_NAMES` lists only current/older names. This is the
 * intended trade-off: never destroy newer-major data a re-upgrade could reopen.
 */
function isReclaimableLegacyName(name: string, baseName: string, currentMajor: number): boolean {
  const match = name.match(new RegExp(`^${escapeRegExp(baseName)}(?:-pg(\\d+))?$`));
  if (!match) {
    return false;
  }
  const major = match[1];
  // Unversioned base = the original (oldest) store; always reclaimable.
  return major === undefined || Number(major) < currentMajor;
}

/**
 * The Postgres major at which data-dir-name versioning was introduced (`-pg18`).
 * Before it, browser stores used the unversioned base name (`app`). Used to
 * enumerate older versioned candidates on browsers that can't list storage.
 */
const FIRST_VERSIONED_PG_MAJOR = 18;

/**
 * Deterministic list of older same-base names to reclaim when the browser CANNOT
 * enumerate storage (no `indexedDB.databases()` / OPFS `keys()`): the unversioned
 * base plus every versioned major from the first versioned major up to — but
 * excluding — the current one. Enumeration is preferred when available; this exists
 * so that even without it, a prior VERSIONED orphan is still reclaimed. Without it,
 * after a second bump (pg18 → pg19) the `app-pg18` store could never be discovered
 * on legacy Safari/Firefox and would leak against the origin quota indefinitely
 * (automatic relief degrading to one major behind). Forward-only: never lists the
 * current or a newer major.
 */
export function enumerationUnavailableLegacyNames(
  baseName: string,
  currentMajor: number
): string[] {
  const names = [baseName];
  for (let major = FIRST_VERSIONED_PG_MAJOR; major < currentMajor; major++) {
    names.push(`${baseName}-pg${major}`);
  }
  return names;
}

/**
 * Prefix PGlite's idb backend gives its actual IndexedDB databases. The backend is
 * Emscripten IDBFS, which names the IndexedDB database after the in-WASM mount path
 * — `/pglite/<dataDir>`, NOT the bare scheme-stripped name. So an `idb://app-pg18`
 * data dir lives in an IndexedDB database literally named `/pglite/app-pg18`.
 *
 * Verified empirically against @electric-sql/pglite@0.5.1: opening
 * `new PGlite({ dataDir: 'idb://probe-xyz' })` under fake-indexeddb and listing
 * `indexedDB.databases()` returns `["/pglite/probe-xyz"]`. Reclaim/deletion MUST
 * use this prefix or it silently matches nothing (the OPFS-AHP backend differs —
 * it stores under the bare name at the OPFS root, see `reclaimLegacyOpfsDirs`).
 * Re-verify on a pglite engine upgrade.
 */
export const IDB_DB_NAME_PREFIX = '/pglite/';

async function legacyIndexedDbNamesToReclaim(
  baseName: string,
  currentMajor: number
): Promise<string[]> {
  if (typeof indexedDB === 'undefined') {
    return [];
  }
  // Enumerate when supported so every older-major orphan is reclaimed, not just
  // the one whose suffix we can derive from the current name. The real DB names are
  // `/pglite/<dataDir>`; strip the prefix to test reclaimability, but return the
  // FULL name so the caller deletes the database that actually exists.
  if (typeof indexedDB.databases === 'function') {
    const infos = await indexedDB.databases();
    return infos
      .map((info) => info.name)
      .filter((name): name is string => typeof name === 'string')
      .filter((name) => name.startsWith(IDB_DB_NAME_PREFIX))
      .filter((name) =>
        isReclaimableLegacyName(name.slice(IDB_DB_NAME_PREFIX.length), baseName, currentMajor)
      );
  }
  // Enumeration unavailable (older Safari/Firefox): we can't discover which
  // stores exist, so target the deterministic set of older same-base candidates
  // (unversioned base + every prior versioned major), each as its real
  // `/pglite/`-prefixed database name. Deleting an absent name is a harmless no-op.
  // The maintained factory-reset list remains a defense-in-depth secondary path,
  // but this already closes the prior-versioned-orphan leak.
  return enumerationUnavailableLegacyNames(baseName, currentMajor).map(
    (name) => `${IDB_DB_NAME_PREFIX}${name}`
  );
}

/**
 * OPFS layout (verified against @electric-sql/pglite@0.5.1, dist/fs/opfs-ahp.js):
 * a data dir `opfs-ahp://app-pg18` has its scheme stripped to `app-pg18`
 * (`dataDir.slice(11)` in index.js) and the OPFS-AHP FS resolves that bare name as
 * a single directory handle directly under the OPFS root
 * (`root.getDirectoryHandle('app-pg18', { create: true })` in its `init`). The
 * engine's per-DB files (`state.txt`, the `data/` pool) live INSIDE that named
 * dir. So each `-pg<N>` major is a distinct top-level root entry, and
 * `root.removeEntry(name, { recursive: true })` reclaims an older major's entire
 * tree in one call. (Our dbName has no `/`, so the name is always a single
 * top-level segment.)
 */
async function reclaimLegacyOpfsDirs(baseName: string, currentMajor: number): Promise<void> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    return;
  }
  const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & {
    keys?: () => AsyncIterable<string>;
  };
  // OWNERSHIP INVARIANT: unlike the IndexedDB path — which guards on the
  // `/pglite/` prefix so it can't touch non-PGlite stores like `brainstrike-desktop`
  // — OPFS-AHP has no prefix (PGlite stores under the BARE name at the root), so a
  // top-level entry named `app`/`web`/`app-pg17` is removed unconditionally. This is
  // safe ONLY because PGlite owns every OPFS root dir matching the base-name pattern
  // today. If a future feature writes an OPFS root directory whose name collides with
  // a reclaimable base / older-major pattern, this background sweep WOULD delete it —
  // namespace such a consumer (or add a prefix guard here) before that happens.
  //
  // Enumerate root entries when supported; otherwise fall back to the deterministic
  // older-candidate set (base + every prior versioned major) so a prior versioned
  // orphan isn't leaked on engines without `keys()`. removeEntry on an absent name
  // throws and is swallowed per-entry below.
  const names: string[] = [];
  if (typeof root.keys === 'function') {
    for await (const name of root.keys()) {
      if (isReclaimableLegacyName(name, baseName, currentMajor)) {
        names.push(name);
      }
    }
  } else {
    names.push(...enumerationUnavailableLegacyNames(baseName, currentMajor));
  }
  for (const name of names) {
    try {
      await root.removeEntry(name, { recursive: true });
    } catch {
      // best-effort: a single stuck entry (e.g. a handle still held by another
      // tab) must not abort reclaiming the remaining variants.
    }
  }
}

/**
 * Best-effort reclamation of legacy (pre-/other-engine-version) browser storage
 * for the same database base name, run once after the versioned database opens.
 *
 * A PG major upgrade versions the data-dir name (idb://app -> idb://app-pg18),
 * which abandons the old database. Without reclamation it counts against the
 * origin's storage quota indefinitely, pressuring the new DB toward eviction.
 *
 * NOTE: this runs AFTER the versioned DB has opened, so it relieves *ongoing*
 * quota pressure but cannot prevent a first-open QuotaExceededError if the orphan
 * already left the origin over quota before bootstrap (largely theoretical — open
 * + schema bootstrap writes are small; reclaiming before open would instead add
 * its enumeration/delete latency to every cold start).
 *
 * Reclaims BOTH the IndexedDB databases and the OPFS directories of every OLDER
 * same-base variant (the unversioned base + any `-pg<N>` with N < the current
 * major), by enumerating storage when the browser supports it (falling back to
 * the unversioned base name otherwise). It deliberately leaves the in-use name
 * AND any newer-major store untouched, so an older build re-run after a newer
 * one never destroys data a later re-upgrade could reopen. This is the AUTOMATIC,
 * per-cold-start cleanup for OLDER-major orphans (no user action); a "Factory Reset
 * Brainstrike" separately clears the CURRENT store too, across both backends —
 * `clearPersistentUiState` now walks the OPFS root as well as IndexedDB
 * (`clearOpfsPGliteStores` in factory-reset-helpers.ts). Fire-and-forget: deleting
 * absent storage is a no-op and any failure is swallowed so reclamation can't break
 * startup.
 *
 * SAME-BASE ONLY (not redundant with the factory-reset list): this reclaims only
 * variants of the CURRENT base name (e.g. `web` → `/pglite/web`, `/pglite/web-pg17`,
 * …). A legacy install under a DIFFERENT base — e.g. an old `idb://brainstrike-web`
 * store (real DB `/pglite/brainstrike-web`) — is never reached here and leaks
 * against origin quota until a factory reset. Such cross-base orphans are covered
 * by `FALLBACK_INDEXED_DB_NAMES` + factory-reset enumeration, which is exactly why
 * that list is the secondary cleanup path rather than dead weight.
 *
 * INTENTIONAL ASYMMETRY vs desktop (do NOT "fix" by adding a retention window):
 * desktop's `reconcileIncompatiblePgDataDir` MOVES an unopenable older-major dir
 * aside to a `.bak` sibling kept for a 14-day forensic window; the browser here
 * instead DELETES the legacy store immediately and permanently on the first boot
 * of the new engine. This is a deliberate greenfield decision — there is no
 * in-browser `pg_upgrade`, a `.bak` would just double quota pressure (the very
 * thing this function exists to relieve), and OPFS/IDB give no cheap rename-aside.
 * Consequence: a web user with an existing index loses it with no retention and no
 * pre-deletion export. Any future export/migration affordance would have to run
 * BEFORE this reclaim (and before the versioned DB opens).
 *
 * ACCEPTED GREENFIELD WIPE (maintainer decision): the data loss here is explicitly
 * accepted — this is a pre-1.0 greenfield app; on an engine-major change the app
 * starts fresh and re-indexes, which is fine by design. So the reclaim runs
 * UNCONDITIONALLY and is deliberately NOT gated behind a flag. A one-time "your
 * index was reset" notice is a nice-to-have UX follow-up (issue #1139), NOT a
 * release blocker. (If that ever changes — e.g. real user data worth preserving —
 * an export affordance must run before this point and the reclaim would need a
 * gate; today it does not.)
 */
export async function reclaimLegacyBrowserPGliteStorage(versionedDataDir: string): Promise<void> {
  if (!isBrowserPersistentPGliteDataDir(versionedDataDir)) {
    return;
  }
  const suffix = `-${PGLITE_DATA_DIR_VERSION}`;
  const currentName = versionedDataDir.replace(/^(idb|opfs-ahp):\/\//, '');
  if (!currentName.endsWith(suffix)) {
    return;
  }
  const baseName = currentName.slice(0, -suffix.length);
  if (baseName.length === 0) {
    return;
  }

  // BOTH backends are reclaimed regardless of the active scheme, by design (NOT a
  // missed scope-to-scheme optimization). The selected backend can differ from a
  // PRIOR build's (a user toggles the OPFS opt-in, or OPFS support appears/
  // disappears), so an OLDER-MAJOR orphan can be stranded under the other scheme —
  // e.g. a PG17 `idb` store after switching to `opfs-ahp` on the PG18 build. The
  // cross-backend pass reclaims those.
  //
  // KNOWN LIMITATION (correct-by-design): reclaim is forward-only (`< currentMajor`),
  // so a SAME-major backend switch is NOT covered — switching idb→opfs-ahp while
  // both are on pg18 leaves the other backend's `/pglite/app-pg18` store untouched
  // (its major `18 < 18` is false), and it persists for the PG18 lifetime, becoming
  // reclaimable only at the next major bump. This is intentional: by name alone an
  // in-use `app-pg18` on one backend is indistinguishable from an orphan on the
  // other, so the "never delete current-major data that might be reopened" invariant
  // wins over relieving that same-major orphan.
  //
  // The cross-backend pass is cheap (one `databases()` + one OPFS root walk) and
  // runs once, fire-and-forget, AFTER open — so it doesn't gate startup.
  try {
    const names = await legacyIndexedDbNamesToReclaim(baseName, PGLITE_ENGINE_MAJOR);
    for (const name of names) {
      // Fire-and-forget by design: we don't observe the request's onsuccess/
      // onerror/onblocked. A delete BLOCKED by an open connection in another tab
      // therefore fails silently and is simply retried on the next cold start
      // (same best-effort contract as the OPFS per-entry guard) — reclamation must
      // never block or fail startup, and the orphan only wastes quota until then.
      indexedDB.deleteDatabase(name);
    }
  } catch {
    // best-effort only
  }

  try {
    await reclaimLegacyOpfsDirs(baseName, PGLITE_ENGINE_MAJOR);
  } catch {
    // best-effort only (entries may be absent, or a handle is still held elsewhere)
  }
}

export function isIndexedDbPGliteDataDir(dataDir: string | undefined): dataDir is string {
  return typeof dataDir === 'string' && dataDir.startsWith('idb://');
}

export function isOpfsAhpPGliteDataDir(dataDir: string | undefined): dataDir is string {
  return typeof dataDir === 'string' && dataDir.startsWith('opfs-ahp://');
}

export function isBrowserPersistentPGliteDataDir(dataDir: string | undefined): dataDir is string {
  return isIndexedDbPGliteDataDir(dataDir) || isOpfsAhpPGliteDataDir(dataDir);
}

export function getBrowserPGliteStorageSupport(): Required<
  Pick<BrowserPGliteStorageSupport, 'hasOpfsDirectory' | 'hasWorker'>
> {
  return {
    hasOpfsDirectory:
      typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function',
    hasWorker: typeof Worker !== 'undefined',
  };
}

export function getRecommendedBrowserPGliteStorage(
  support: BrowserPGliteStorageSupport = getBrowserPGliteStorageSupport()
): BrowserPGliteStorageSelection {
  const hasOpfsAhpSupport = support.hasWorker === true && support.hasOpfsDirectory === true;
  if (support.requestedStorage === 'opfs-ahp') {
    if (hasOpfsAhpSupport) {
      return {
        dataDir: getOpfsAhpBrowserPGliteDataDir(),
        reason: 'requested-opfs-ahp-supported',
        storage: 'opfs-ahp',
      };
    }
    return {
      dataDir: getDefaultBrowserPGliteDataDir(),
      reason: 'requested-opfs-ahp-unavailable',
      storage: 'idb',
    };
  }

  return {
    dataDir: getDefaultBrowserPGliteDataDir(),
    reason:
      support.requestedStorage === 'idb' ? 'requested-indexeddb' : 'pglite-recommends-indexeddb',
    storage: 'idb',
  };
}
