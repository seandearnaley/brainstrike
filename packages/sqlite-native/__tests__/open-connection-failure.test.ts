import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openConnection } from '../src/open-connection.js';

// The only seam replaced is where sqlite-vec points; the extension load that
// fails and the connection that must be closed are the real better-sqlite3.
vi.mock('sqlite-vec', () => ({
  getLoadablePath: () => join(tmpdir(), 'sqlite-native-absent-extension', 'vec0.so'),
}));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sqlite-native-failure-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { force: true, recursive: true });
});

it('closes the connection it opened when the extension fails to load', () => {
  const close = vi.spyOn(Database.prototype, 'close');

  expect(() => openConnection(join(root, 'failed-load.db'))).toThrow();

  expect(close).toHaveBeenCalledTimes(1);
});
