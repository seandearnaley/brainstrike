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
 * this is a raw source-text contract over `main.ts` (and, since BST-1648
 * step 4 moved the construction into `main/git-awareness-lifecycle.ts`, over
 * that module for the wiring-shape checks), matching the pattern in
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
const lifecycleTsPath = path.join(repoRoot, 'apps/desktop/src/main/git-awareness-lifecycle.ts');
const source = readFileSync(mainTsPath, 'utf8');
const lifecycleSource = readFileSync(lifecycleTsPath, 'utf8');

function requireIndexIn(haystack, haystackPath, needle, description) {
  const index = haystack.indexOf(needle);
  assert.ok(
    index !== -1,
    `expected to find ${description} in ${haystackPath}: ${JSON.stringify(needle)}`
  );
  return index;
}

function requireIndexOf(needle, description) {
  return requireIndexIn(source, mainTsPath, needle, description);
}

function requireLifecycleIndexOf(needle, description) {
  return requireIndexIn(lifecycleSource, lifecycleTsPath, needle, description);
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

test("forge shutdown is its own step, before 'database', not nested inside 'git-inventory' (BST-1391)", () => {
  // A prior revision nested forge teardown INSIDE the 'git-inventory' step,
  // after `await gitInventoryService.stop()`. `stop()`'s final `await
  // toDispose.disposeAll()` is unguarded, and `runShutdownStep` catches a
  // rejection at the step boundary, so a throwing watcher disposer would
  // silently skip forge teardown entirely — leaving `ipcMain` handlers
  // registered and a live `forgeService` heading into 'database'. forge gets
  // its own failure-isolated step for the same DB-availability reason as
  // git-inventory (`getDatabase` -> `readForgePrCacheEntry`/
  // `writeForgePrCacheEntry`), so it must run BEFORE 'database' too.
  const gitInventoryStepIndex = requireIndexOf(
    "runShutdownStep('git-inventory'",
    "the 'git-inventory' runShutdownStep call"
  );
  const forgeStepIndex = requireIndexOf(
    "runShutdownStep('forge'",
    "the 'forge' runShutdownStep call"
  );
  const databaseStepIndex = requireIndexOf(
    "runShutdownStep('database'",
    "the 'database' runShutdownStep call"
  );
  const unregisterCallIndex = requireIndexOf(
    'unregisterForgeIpc?.();',
    'the unregisterForgeIpc() call inside forge teardown'
  );

  assert.ok(
    gitInventoryStepIndex < forgeStepIndex,
    "the 'forge' runShutdownStep call must come AFTER the 'git-inventory' step call site, " +
      'proving it is a sibling step rather than nested inside it'
  );
  assert.ok(
    forgeStepIndex < databaseStepIndex,
    "the 'forge' shutdown step must run BEFORE 'database' — forge reads the DB " +
      '(getDatabase -> readForgePrCacheEntry/writeForgePrCacheEntry), so it must be torn ' +
      'down while the database is still available'
  );
  assert.ok(
    forgeStepIndex < unregisterCallIndex && unregisterCallIndex < databaseStepIndex,
    'unregisterForgeIpc() must be called from inside the forge step, between its ' +
      "runShutdownStep('forge', ...) call and the 'database' step — a copy-paste that left " +
      "it inside 'git-inventory' instead would still pass the ordering check above alone"
  );
});

test('the changes:invalidated broadcast AND forge invalidation ride the same onInvalidate callback (BST-1161, BST-1391)', () => {
  // BST-1391 W4 Task 3 replaced the literal `onInvalidate:
  // broadcastChangesInvalidation` dep with a composed callback so the SAME
  // git-metadata-watcher event also drives `forgeService.onRepositoryInvalidated`.
  // Both calls must be asserted independently, and falsifiably: dropping
  // EITHER one from the callback body must fail this test, because dropping
  // `broadcastChangesInvalidation(event)` silently reverts the changes
  // domain to manual-refresh-only, and dropping the forge call silently
  // reverts forge PR awareness to window-focus-only polling.
  const constructIndex = requireLifecycleIndexOf(
    'const gitInventoryService = createGitInventoryService(',
    'the gitInventoryService construction site'
  );
  const onInvalidateIndex = requireLifecycleIndexOf(
    'onInvalidate: (event) => {',
    'the onInvalidate dep wiring the composed invalidation callback'
  );
  const broadcastCallIndex = requireLifecycleIndexOf(
    'broadcastChangesInvalidation(event);',
    'the onInvalidate callback invoking broadcastChangesInvalidation with the watcher event'
  );
  const forgeInvalidateCallIndex = requireLifecycleIndexOf(
    'forgeService.onRepositoryInvalidated(event.gitCommonDir);',
    'the onInvalidate callback riding forgeService.onRepositoryInvalidated on the SAME callback'
  );
  requireLifecycleIndexOf(
    'DESKTOP_IPC_CHANNELS.changes.invalidated',
    'the changes.invalidated channel send inside broadcastChangesInvalidation'
  );
  // `run: execFileGitRunner,` (not the bare import) marks the end of this
  // construction's `onInvalidate` property, bounding the window both calls
  // must fall inside — proving they belong to the SAME callback body rather
  // than merely appearing somewhere in the file.
  const onInvalidatePropEndIndex = requireLifecycleIndexOf(
    'run: execFileGitRunner,',
    "the gitInventoryService construction's run dep, closing the onInvalidate property"
  );

  assert.ok(
    Math.abs(onInvalidateIndex - constructIndex) < 3000,
    'the onInvalidate dep must be part of the gitInventoryService construction — a service ' +
      'constructed without it silently reverts the changes domain to manual-refresh-only'
  );
  assert.ok(
    onInvalidateIndex < broadcastCallIndex &&
      broadcastCallIndex < forgeInvalidateCallIndex &&
      forgeInvalidateCallIndex < onInvalidatePropEndIndex,
    'broadcastChangesInvalidation(event) and forgeService.onRepositoryInvalidated(...) must ' +
      'both sit INSIDE the same onInvalidate callback body, broadcast first — a rewrite that ' +
      'splits them into separate wiring, reorders them, or drops one would still pass a ' +
      'presence-only check'
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

  // BST-1648 step 4: the construction + start() live in
  // main/git-awareness-lifecycle.ts; main.ts reaches them ONLY through the
  // startGitAwarenessLifecycle(...) call, which must sit inside whenReady.
  const lifecycleCallIndex = requireIndexOf(
    'const gitAwareness = startGitAwarenessLifecycle({',
    'the startGitAwarenessLifecycle(...) call site'
  );
  assert.ok(
    whenReadyIndex < lifecycleCallIndex && lifecycleCallIndex < guardEndIndex,
    'startGitAwarenessLifecycle(...) must be INSIDE app.whenReady() — calling it at module ' +
      'scope runs before the single-instance-lock guard and before the app is ready'
  );
  assert.equal(
    source.indexOf('createGitInventoryService('),
    -1,
    'main.ts must not construct a GitInventoryService itself — the ONE construction site is ' +
      'main/git-awareness-lifecycle.ts, reached only from inside app.whenReady()'
  );
  assert.equal(
    source.indexOf('startGitAwarenessLifecycle('),
    source.lastIndexOf('startGitAwarenessLifecycle('),
    'exactly one startGitAwarenessLifecycle(...) call site in main.ts'
  );

  const constructIndex = requireLifecycleIndexOf(
    'const gitInventoryService = createGitInventoryService(',
    'the gitInventoryService construction site'
  );
  const startIndex = requireLifecycleIndexOf(
    'gitInventoryService.start();',
    'the gitInventoryService.start() call'
  );
  assert.ok(
    constructIndex < startIndex,
    'gitInventoryService must be constructed before start() is called on it'
  );
  assert.equal(
    lifecycleSource.indexOf('gitInventoryService.start();'),
    lifecycleSource.lastIndexOf('gitInventoryService.start();'),
    'exactly one start() call — the lifecycle module never starts the inventory twice'
  );
});
