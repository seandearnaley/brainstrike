// ADR-0031: the index's one writer never waits on another connection's lock; it is refused at once
// (better-sqlite3's default busy timeout waited 5 s).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openConnection } from '@brainstrike/sqlite-native';
import { afterEach, expect, it } from 'vitest';
import { openDesktopIndex } from '../src/desktop-index-connection.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('refuses a write at once while another connection holds the write lock', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-index-busy-'));
  directories.push(directory);
  const dbPath = path.join(directory, 'index.sqlite');
  const index = openDesktopIndex({ dbPath, embedding: { indexMode: 'text-only' }, rootIds: [] });
  const other = openConnection(dbPath);
  try {
    index.db.pragma('journal_mode = WAL');
    other.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    expect(() => index.db.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
    expect(performance.now() - started).toBeLessThan(1000);
  } finally {
    other.close();
    index.db.close();
    index.truth?.close();
  }
});
