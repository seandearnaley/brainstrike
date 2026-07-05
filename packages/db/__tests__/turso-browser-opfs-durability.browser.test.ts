import { afterAll, describe, expect, it } from 'vitest';
import {
  applyTursoBrowserWasmForeignKeys,
  createTursoBrowserWasmExecutionClient,
  openTursoBrowserWasmStoreWithBoundedWorkerInitRetry,
  runTursoBrowserWasmBootstrap,
  type TursoBrowserWasmBootstrapDatabase,
} from '../src/bootstrap/turso-browser-wasm-bootstrap.js';
import { TursoFileRecordRepository } from '../src/repositories/turso-file-record-repository.js';
import { openTursoBrowserWasmDatabase } from '../src/turso/browser-wasm-client.js';

/**
 * OPFS durability proof for the browser Turso WAL store (the "offline
 * semantics" browser-cutover gate): rows written through the real
 * @tursodatabase/database-wasm store — with NO explicit checkpoint — must
 * survive a store close and re-open of the SAME OPFS path in the same page
 * session. If rows vanish here, the vendor close path is not honoring WAL
 * checkpointing/persistence and that is REAL SIGNAL, not something to paper
 * over.
 *
 * Deliberate scope limit (documented in the migration ledger): a durability
 * proof ACROSS A PAGE RELOAD is not expressible in vitest browser mode — the
 * tester runs in an orchestrated iframe and any page reload aborts the run
 * ("Vitest unexpectedly reloaded a test"), so the reload-shaped proof
 * belongs to a web E2E lane. Same-session close/re-open is the strongest
 * durability contract this lane can express, and it exercises the exact
 * vendor close path the provider uses on unmount and factory reset.
 */
describe('browser Turso OPFS durability (real browser WASM over OPFS)', () => {
  const dbPath = `brainstrike-browser-turso-durability-${crypto.randomUUID()}.db`;
  let openDatabase: TursoBrowserWasmBootstrapDatabase | null = null;

  afterAll(async () => {
    if (openDatabase) {
      try {
        await openDatabase.close();
      } catch {
        // Already closed.
      }
      openDatabase = null;
    }
    for (const fileName of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-tshm`]) {
      await removeOpfsFileIfPresent(fileName);
    }
  });

  it('persists rows across store close and re-open on the same OPFS path', async () => {
    const bootstrapResult = await runTursoBrowserWasmBootstrap({ dbPath, profileId: dbPath });
    expect(bootstrapResult.bootstrapReport.ready).toBe(true);

    // Session 1: open, write (plain writes AND a committed transaction),
    // close. No explicit WAL checkpoint anywhere — durability must come from
    // the vendor close path itself.
    const first = await openStore(dbPath);
    openDatabase = first;
    const firstClient = createTursoBrowserWasmExecutionClient(first);
    const firstRepository = new TursoFileRecordRepository(firstClient);

    await firstRepository.createWithContent({
      content: 'durable content written before close',
      contentHash: 'hash-durability-file',
      createdAt: '2026-07-05T00:00:00.000Z',
      id: 'file-durability',
      name: 'durable.ts',
      path: 'src/durable.ts',
      size: 37,
      tokenCount: 7,
      updatedAt: '2026-07-05T00:00:00.000Z',
    });
    await firstClient.transaction(async (tx) => {
      await tx.exec(
        `INSERT INTO roots (id, kind, display_name, path, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        [
          'root-durability',
          'path',
          'Durability Root',
          '/workspace/root-durability',
          'live',
          '2026-07-05T00:00:00.000Z',
        ]
      );
    });

    await first.close();
    openDatabase = null;

    // Session 2 (same page): re-open the SAME OPFS path — every row written
    // before the close must still be there, including the quick-open name
    // gram sidecars the repository maintains.
    const second = await openStore(dbPath);
    openDatabase = second;
    const secondClient = createTursoBrowserWasmExecutionClient(second);
    const secondRepository = new TursoFileRecordRepository(secondClient);

    const reloadedRecord = await secondRepository.findById('file-durability');
    expect(reloadedRecord).toMatchObject({
      content: 'durable content written before close',
      contentHash: 'hash-durability-file',
      id: 'file-durability',
      name: 'durable.ts',
      path: 'src/durable.ts',
    });
    await expect(secondRepository.findByNameSubstring('durable', 10)).resolves.toEqual([
      expect.objectContaining({ id: 'file-durability', name: 'durable.ts' }),
    ]);

    const rootRows = await secondClient.query<{ display_name: string; id: string }>(
      'SELECT id, display_name FROM roots WHERE id = ?',
      ['root-durability']
    );
    expect(rootRows.rows).toEqual([{ display_name: 'Durability Root', id: 'root-durability' }]);

    // The re-opened store still honors the browser WAL journal-mode contract.
    const journalModeRows = await secondClient.query<{ journal_mode: string }>(
      'PRAGMA journal_mode'
    );
    expect(journalModeRows.rows[0]?.journal_mode?.toLowerCase()).toBe('wal');

    await second.close();
    openDatabase = null;
  });
});

async function openStore(path: string): Promise<TursoBrowserWasmBootstrapDatabase> {
  const opened = await openTursoBrowserWasmStoreWithBoundedWorkerInitRetry(
    async (dbPath: string) => openTursoBrowserWasmDatabase({ path: dbPath }),
    path
  );
  // Production-client fidelity: every post-bootstrap open applies the
  // per-connection foreign-keys pragma, exactly like the provider open.
  await applyTursoBrowserWasmForeignKeys(opened.database);
  return opened.database;
}

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
