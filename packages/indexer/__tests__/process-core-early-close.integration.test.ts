// BST-2472: quitting the app right after launch closes the index while its writer thread is
// still starting. That writer must be left to finish and close its own database: a thread
// terminated inside better-sqlite3's native initialisation aborts the whole agent host.
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { runIndexerProcess } from '../src/process-core.ts';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose();
  }
});

it('a Close that arrives while the writer is starting leaves it to open and close its index', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-early-close-')));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const dbPath = path.join(root, 'index.sqlite');
  const messages: object[] = [];
  const finished = Promise.withResolvers<void>();
  let receive: (message: unknown) => void = () => {
    throw new Error('No message listener');
  };
  const completed = runIndexerProcess(
    {
      dbPath,
      stateProjection: {
        mode: 'dev',
        module: new URL('./fixtures/state-schema.mjs', import.meta.url).href,
      },
      stateRoot: root,
    },
    {
      finish: () => finished.resolve(),
      onMessage: (listener) => {
        receive = listener;
      },
      send: (message) => {
        messages.push(message);
      },
    }
  );
  // The writer thread was created one statement ago, so it has not started yet.
  receive({ id: 7, op: 'close', payload: null });
  await completed;
  await finished.promise;

  expect(messages).toEqual([{ id: 7, kind: 'response', ok: true, value: true }]);
  // A writer that was killed never creates its index. One that was asked to close did,
  // and left a whole database behind.
  expect(existsSync(dbPath)).toBe(true);
  const index = new Database(dbPath, { fileMustExist: true, readonly: true });
  try {
    expect(index.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      index
        .prepare("SELECT count(*) FROM sqlite_master WHERE name = 'index_metadata'")
        .pluck()
        .get()
    ).toBe(1);
  } finally {
    index.close();
  }
});
