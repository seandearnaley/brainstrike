import { afterEach, describe, expect, it } from 'vitest';
import { runTursoBrowserWasmBootstrap } from '../src/bootstrap/turso-browser-wasm-bootstrap.js';

describe('Turso browser WASM bootstrap smoke', () => {
  const openedDbPaths: string[] = [];

  afterEach(async () => {
    for (const dbPath of openedDbPaths.splice(0)) {
      await removeOpfsFileIfPresent(dbPath);
      await removeOpfsFileIfPresent(`${dbPath}-wal`);
      await removeOpfsFileIfPresent(`${dbPath}-shm`);
    }
  });

  it('runs the real browser WASM path and fails closed before claiming readiness', async () => {
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
      failure: {
        code: 'turso_browser_wasm_bootstrap_failed',
      },
      phase: 'failed',
      ready: false,
    });
    expect(report.blockingIssues).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(
          `Bootstrap failed during ${report.bootstrapReport.failure?.phase}`
        ),
        phase: 'failed',
        severity: 'blocking',
      }),
    ]);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'browser.cross-origin-isolated', status: 'passed' }),
        expect.objectContaining({ id: 'browser.opfs', status: 'passed' }),
        expect.objectContaining({ id: 'schema.baseline', status: 'pending' }),
      ])
    );

    if (report.bootstrapReport.failure?.phase === 'opening-store') {
      expect(report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'store.open',
            message: expect.stringContaining("reading 'whenLoaded'"),
            status: 'failed',
          }),
          expect.objectContaining({ id: 'primary-store.mvcc', status: 'pending' }),
        ])
      );
      return;
    }

    if (report.bootstrapReport.failure?.phase === 'probing-capabilities') {
      expect(report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'store.open', status: 'passed' }),
          expect.objectContaining({
            id: 'primary-store.mvcc',
            message: 'unreachable',
            status: 'failed',
          }),
        ])
      );
      return;
    }

    throw new Error(
      `Unexpected Turso browser WASM smoke failure phase: ${report.bootstrapReport.failure?.phase}`
    );
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
