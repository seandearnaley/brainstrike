import { readFile } from 'node:fs/promises';
import { expect, inject, it, vi } from 'vitest';
import { createBrainstrikePglite } from '../src/pglite-factory.js';

async function openFixture(loadDataDir?: Blob) {
  const snapshot = loadDataDir ?? new Blob([await readFile(inject('dbSnapshotPath'))]);
  return createBrainstrikePglite({ loadDataDir: snapshot });
}

function holdProtocol(db: Awaited<ReturnType<typeof openFixture>>) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const execute = db.execProtocolRaw.bind(db);
  vi.spyOn(db, 'execProtocolRaw').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return execute(...args);
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

it('joins a running protocol write before close acknowledges physical disposal', async () => {
  const db = await openFixture();
  try {
    await db.exec('CREATE TABLE dependency_close_proof (id integer PRIMARY KEY)');
    const protocol = holdProtocol(db);
    const write = db.query<{ id: number }>(
      'INSERT INTO dependency_close_proof VALUES (42) RETURNING id'
    );
    await protocol.entered;
    const close = db.close();
    protocol.release();
    const [result] = await Promise.all([write, close]);
    expect(result.rows).toEqual([{ id: 42 }]);
    expect(db.closed).toBe(true);
  } finally {
    if (!db.closed) {
      await db.close();
    }
  }
});

it('joins a running protocol write before dump and preserves populated reopen and deletion', async () => {
  const db = await openFixture();
  let snapshot: Blob;
  try {
    await db.exec('CREATE TABLE dependency_dump_proof (id integer PRIMARY KEY)');
    const protocol = holdProtocol(db);
    const write = db.query('INSERT INTO dependency_dump_proof VALUES (42)');
    await protocol.entered;
    const dump = db.dumpDataDir('none');
    protocol.release();
    [, snapshot] = await Promise.all([write, dump]);
  } finally {
    await db.close();
  }
  const reopened = await openFixture(snapshot);
  let cleared: Blob;
  try {
    expect((await reopened.query('SELECT id FROM dependency_dump_proof')).rows).toEqual([
      { id: 42 },
    ]);
    await reopened.exec('DELETE FROM dependency_dump_proof');
    cleared = await reopened.dumpDataDir('none');
  } finally {
    await reopened.close();
  }
  const afterDelete = await openFixture(cleared);
  try {
    expect((await afterDelete.query('SELECT id FROM dependency_dump_proof')).rows).toEqual([]);
  } finally {
    await afterDelete.close();
  }
});

it('releases the windowed live-query count statement on unsubscribe', async () => {
  const db = await openFixture();
  try {
    const live = await db.live.query({
      limit: 1,
      offset: 0,
      query: 'SELECT id FROM generate_series(1, 3) AS id',
    });
    expect(live.initialResults.totalCount).toBe(3);
    await live.unsubscribe();
    expect(
      (
        await db.query(
          "SELECT name FROM pg_prepared_statements WHERE name LIKE 'live_query_%_get_total_count'"
        )
      ).rows
    ).toEqual([]);
  } finally {
    await db.close();
  }
});
