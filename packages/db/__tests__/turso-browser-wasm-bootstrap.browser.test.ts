import { afterEach, describe, expect, it } from 'vitest';
import { runTursoBrowserWasmBootstrap } from '../src/bootstrap/turso-browser-wasm-bootstrap.js';

/**
 * Readiness proof for the real browser Turso WASM path (real
 * @tursodatabase/database-wasm store over OPFS, no mocks).
 *
 * Under the browser WAL journal-mode contract the bootstrap must reach a
 * ready report: the MVCC pragma is never issued (it panics upstream and
 * wedges the wasm instance), PRAGMA journal_mode reports 'wal', and the
 * schema-baseline + gram-index + vector32 probes execute for real. Store-open
 * reliability (the transient emnapi worker-init race) is covered by the
 * bounded retry inside the bootstrap.
 */
describe('Turso browser WASM bootstrap smoke', () => {
  const openedDbPaths: string[] = [];

  afterEach(async () => {
    for (const dbPath of openedDbPaths.splice(0)) {
      await removeOpfsFileIfPresent(dbPath);
      await removeOpfsFileIfPresent(`${dbPath}-wal`);
      await removeOpfsFileIfPresent(`${dbPath}-shm`);
    }
  });

  it('runs the real browser WASM path to a ready WAL single-writer report', async () => {
    const dbPath = `brainstrike-turso-browser-smoke-${crypto.randomUUID()}.db`;
    openedDbPaths.push(dbPath);

    expect(typeof window).toBe('object');
    expect(crossOriginIsolated).toBe(true);
    expect(typeof SharedArrayBuffer).toBe('function');
    expect(typeof navigator.storage.getDirectory).toBe('function');

    const report = await runTursoBrowserWasmBootstrap({
      dbPath,
      generatedAt: createClock(),
      profileId: 'browser-smoke',
    });

    expect(report.bootstrapReport).toMatchObject({
      capabilities: {
        concurrentWrites: false,
        journalMode: 'wal',
      },
      failure: null,
      phase: 'ready',
      profileId: 'browser-smoke',
      ready: true,
      runtime: {
        engine: 'turso',
        host: 'browser',
        persistence: 'opfs',
      },
      search: {
        indexedSearch: 'available',
        ownershipMode: 'split-search-index-store',
      },
    });
    expect(report.bootstrapReport.search.message).toContain('single-writer');
    expect(report.blockingIssues).toEqual([]);
    expect(report.checks).toEqual([
      expect.objectContaining({ id: 'browser.runtime', status: 'passed' }),
      expect.objectContaining({ id: 'browser.cross-origin-isolated', status: 'passed' }),
      expect.objectContaining({ id: 'browser.opfs', status: 'passed' }),
      expect.objectContaining({ id: 'store.open', status: 'passed' }),
      expect.objectContaining({ id: 'primary-store.journal-mode', status: 'passed' }),
      expect.objectContaining({ id: 'schema.baseline', status: 'passed' }),
      expect.objectContaining({ id: 'search.grep-content-grams', status: 'passed' }),
      expect.objectContaining({ id: 'search.vector32-functions', status: 'passed' }),
      expect.objectContaining({ id: 'search.ownership', status: 'passed' }),
      expect.objectContaining({ id: 'store.close', status: 'passed' }),
    ]);
  });
});

async function removeOpfsFileIfPresent(fileName: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(fileName);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return;
    }
    throw error;
  }
}

function createClock(): () => string {
  let tick = 0;
  return () => `2026-07-04T01:00:0${tick++}.000Z`;
}
