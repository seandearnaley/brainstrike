import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { RootLock } from '@brainstrike/state-store';
import { build } from 'tsup';
import { expect, test } from 'vitest';
import { runFixtureProcess } from './fixtures/fixture-process.js';

const driver = path.join(import.meta.dirname, 'fixtures/node-native-text-services.mjs');
const desktop = path.resolve(import.meta.dirname, '../../../../apps/desktop/src');
const captured = fileURLToPath(
  import.meta.resolve('@brainstrike/test-utils/fixtures/canonical-provided-chunks.json')
);

/** Whether this Node's SQLite was compiled without memory accounting. */
function memoryAccountingDisabled(): boolean {
  const database = new DatabaseSync(':memory:');
  try {
    return (
      database
        .prepare("SELECT 1 FROM pragma_compile_options WHERE compile_options='DEFAULT_MEMSTATUS=0'")
        .get() !== undefined
    );
  } finally {
    database.close();
  }
}

type Mode = 'provenance' | 'query' | 'query-refused' | 'stop';

/** Seeds a fixture profile, then runs one mode in a fresh plain Node process; returns its receipt. */
async function runFixture(mode: Mode, signal: AbortSignal): Promise<unknown> {
  const fixture = await mkdtemp(path.join(tmpdir(), 'bs-node-native-text-'));
  const ownerBundles = await mkdtemp(path.join(path.dirname(driver), '.m3-native-text-'));
  try {
    const entries = [
      'desktop-profile-runtime',
      'native-index-runtime',
      'native-index-settings',
      'native-authority-transition',
      'native-index-setup-required',
      'native-index-search',
      'native-scoped-search',
    ];
    await build({
      bundle: true,
      clean: false,
      dts: false,
      entry: Object.fromEntries(entries.map((name) => [name, path.join(desktop, `${name}.ts`)])),
      external: [/^@brainstrike\//],
      format: ['esm'],
      outDir: ownerBundles,
      silent: true,
      splitting: false,
    });
    expect(
      await runFixtureProcess(driver, ['seed', fixture, captured, ownerBundles], signal)
    ).toMatchObject({
      electron: false,
      seeded: true,
    });
    return await runFixtureProcess(driver, [mode, fixture, captured, ownerBundles], signal);
  } finally {
    const owner = RootLock.inspect(path.join(fixture, 'profiles', 'selected'));
    // Failed joins retain their physical evidence and are never retried by fixture cleanup.
    if (!owner || owner.owner.released) {
      await rm(fixture, { force: true, recursive: true });
      await rm(ownerBundles, { force: true, recursive: true });
    } else {
      await rename(ownerBundles, path.join(fixture, 'retained-owner-bundles'));
    }
  }
}

const authorizedSearch = {
  authorizedBeforeRanking: true,
  exactProvenance: true,
  partialCoverage: true,
  reopened: true,
  revokedRefused: true,
  savedChoiceDriftRefused: true,
};

test('public plain Node TEXT borrows real native SQLite authority: provenance', async ({
  signal,
}) => {
  expect(await runFixture('provenance', signal)).toMatchObject({
    constructorIdentity: true,
    electron: false,
    joined: true,
    mode: 'provenance',
    sameLease: true,
    ...authorizedSearch,
  });
}, 60_000);

test('public plain Node TEXT borrows real native SQLite authority: stop', async ({ signal }) => {
  expect(await runFixture('stop', signal)).toMatchObject({
    constructorIdentity: true,
    electron: false,
    joined: true,
    mode: 'stop',
    noLatePublication: true,
    sameLease: true,
    stopJoined: true,
  });
}, 60_000);

// The query sandbox refuses a SQLite build without memory accounting
// (docs/archive/agent-contract-history/agent-self-query/sqlite-index-foundation.md),
// and the plain Node runtimes here (24.16.0
// and the pinned 26.8.2) are such builds. Plain Node/CLI support is BST-1941's.
test('public plain Node TEXT refuses a query runtime without SQLite memory accounting', async ({
  signal,
}) => {
  // When this fails, this runtime can enforce the heap limit: enable the BST-1941 case below.
  expect(memoryAccountingDisabled()).toBe(true);
  expect(await runFixture('query-refused', signal)).toMatchObject({
    constructorIdentity: true,
    electron: false,
    joined: true,
    mode: 'query-refused',
    runtimeRefused: true,
    sameLease: true,
    ...authorizedSearch,
  });
}, 60_000);

// FIXME(BST-1941): plain Node/CLI query support is not established, so the
// sandbox refuses these runtimes (the case above). Vitest has no `test.fixme`;
// enable this once a supported plain-Node runtime enforces the heap limit.
test.skip('public plain Node TEXT borrows real native SQLite authority: query', async ({
  signal,
}) => {
  expect(await runFixture('query', signal)).toMatchObject({
    cleanupFailureVisible: true,
    constructorIdentity: true,
    electron: false,
    joined: true,
    mode: 'query',
    sameLease: true,
    ...authorizedSearch,
  });
}, 60_000);
