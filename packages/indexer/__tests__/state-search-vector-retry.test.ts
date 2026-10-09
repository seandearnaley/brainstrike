// The semantic arm's failure window, on the class's own clock.
import { openConnection } from '@brainstrike/sqlite-native';
import { afterEach, expect, it } from 'vitest';
import { StateSearchVectors } from '../src/state-search-vectors.js';

const profile = {
  dimensions: 2,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'retry-proof',
  provider: 'local',
} as const;

const owned: (() => void)[] = [];
afterEach(() => {
  for (const close of owned.splice(0)) {
    close();
  }
});

it('a failed row returns to the backlog once the retry window has passed', () => {
  const db = openConnection(':memory:');
  owned.push(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE state_event_rows(pk INTEGER PRIMARY KEY);
    CREATE TABLE state_search_rows(event_pk INTEGER PRIMARY KEY REFERENCES state_event_rows(pk) ON DELETE CASCADE,thread_id TEXT NOT NULL,seq INTEGER NOT NULL,run_id TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL);
    INSERT INTO state_event_rows VALUES(1);
    INSERT INTO state_search_rows VALUES(1,'one',1,'run-1','user','Garden notes');
    ${StateSearchVectors.definition}
    ${StateSearchVectors.failureDefinition}
  `);
  let now = 1_000_000;
  const vectors = new StateSearchVectors(db, () => now);
  const pending = () => vectors.pending({ limit: 10, profile, threadIds: ['one'] });
  const [row] = pending();
  if (!row) {
    throw new Error('Expected one backlog row');
  }
  vectors.put({
    profile,
    rows: [
      { error: 'model unavailable', seq: row.seq, sourceHash: row.sourceHash, threadId: 'one' },
    ],
  });
  expect(pending()).toEqual([]);
  expect(vectors.coverage({ profile, threadIds: ['one'] })).toEqual({
    embedded: 0,
    errored: 1,
    rows: 1,
  });

  // Just inside the window it is still errored; past it, the row is pending again.
  now += StateSearchVectors.retryAfterMs - 1;
  expect(pending()).toEqual([]);
  now += 1;
  expect(pending()).toEqual([row]);
  expect(vectors.coverage({ profile, threadIds: ['one'] })).toEqual({
    embedded: 0,
    errored: 0,
    rows: 1,
  });
});
