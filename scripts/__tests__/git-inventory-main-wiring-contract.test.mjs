/**
 * Source-level contract for `apps/desktop/src/main.ts`'s BST-1112 git
 * inventory wiring. The factory-contract unit tests in
 * `apps/desktop/src/__tests__/assistant-server/git-inventory-service-lifecycle.test.ts`
 * constrain `createGitInventoryService` itself, not how `main.ts` WIRES it —
 * two real defects (both caught by review, not by the existing suite) lived
 * entirely in that wiring:
 *
 *   1. `gitInventoryService.start()` was called at MODULE scope, above
 *      `app.whenReady()`. `start()`'s eager build reaches `getDatabase()` →
 *      `utilityProcess.fork`, which Electron rejects before the app is
 *      ready — a guaranteed, silently-swallowed failure on every production
 *      boot (the build's own try/catch turns it into a cached, empty
 *      "no repositories" snapshot with nothing logged).
 *   2. The `'git-inventory'` graceful-shutdown step must run BEFORE the
 *      `'database'` step (its own `main.ts` comment says so: `loadRoots`
 *      reads the DB, so the service's watchers/in-flight build must be torn
 *      down while the DB is still available) — a step reorder would pass
 *      every unit test for the service itself while breaking shutdown.
 *
 * Neither of these is reachable by constructing the service in isolation, so
 * this is a raw source-text contract over `main.ts`, matching the pattern in
 * `db-test-discovery-contract.test.mjs`. It is intentionally crude — the goal
 * is a cheap tripwire, not a semantic parse of `main.ts`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainTsPath = path.join(repoRoot, 'apps/desktop/src/main.ts');
const source = readFileSync(mainTsPath, 'utf8');

function requireIndexOf(needle, description) {
  const index = source.indexOf(needle);
  assert.ok(
    index !== -1,
    `expected to find ${description} in ${mainTsPath}: ${JSON.stringify(needle)}`
  );
  return index;
}

test('git-inventory shutdown step runs before the database shutdown step', () => {
  const gitInventoryStepIndex = requireIndexOf(
    "runShutdownStep('git-inventory'",
    "the 'git-inventory' runShutdownStep call"
  );
  const databaseStepIndex = requireIndexOf(
    "runShutdownStep('database'",
    "the 'database' runShutdownStep call"
  );
  assert.ok(
    gitInventoryStepIndex < databaseStepIndex,
    "the 'git-inventory' shutdown step must run BEFORE 'database': its loadRoots dependency " +
      'reads the DB, so watchers/in-flight builds must be torn down while the database is ' +
      'still available (see the git-inventory-service comment at the runShutdownStep call site)'
  );
});

test('gitInventoryService is constructed and started inside app.whenReady(), never at module scope', () => {
  const whenReadyIndex = requireIndexOf(
    'app.whenReady().then(',
    'the app.whenReady().then(...) call'
  );
  // Anchors the end of the whenReady/single-instance-lock guard block: the
  // `else` branch of `if (singleInstanceLockAcquired) { ... } else { ... }`
  // sits immediately after the whenReady promise chain closes.
  const guardEndIndex = requireIndexOf(
    "} else {\n  logger.warn('Another BrainStrike desktop process is already running",
    'the end of the singleInstanceLockAcquired guard (the `} else { logger.warn(...) }` branch)'
  );
  assert.ok(
    whenReadyIndex < guardEndIndex,
    'app.whenReady().then(...) must appear before the singleInstanceLockAcquired guard closes'
  );

  const constructIndex = requireIndexOf(
    'gitInventoryService = createGitInventoryService(',
    'the gitInventoryService construction site'
  );
  const startIndex = requireIndexOf(
    'gitInventoryService.start();',
    'the gitInventoryService.start() call'
  );

  assert.ok(
    whenReadyIndex < constructIndex && constructIndex < guardEndIndex,
    'gitInventoryService construction must be INSIDE app.whenReady() — constructing it at ' +
      'module scope runs before the single-instance-lock guard and before the app is ready'
  );
  assert.ok(
    whenReadyIndex < startIndex && startIndex < guardEndIndex,
    "gitInventoryService.start() must be INSIDE app.whenReady() — start()'s eager build " +
      'reaches getDatabase() -> utilityProcess.fork, which Electron rejects before the app ' +
      'is ready, silently failing on every production boot if called at module scope'
  );
  assert.ok(
    constructIndex < startIndex,
    'gitInventoryService must be constructed before start() is called on it'
  );
});
