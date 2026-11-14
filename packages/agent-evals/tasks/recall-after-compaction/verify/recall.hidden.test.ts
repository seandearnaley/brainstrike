import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { address, PORT } from '../src/server.ts';

test('the service listens on the port the decisions doc settles on', () => {
  assert.equal(PORT, 8443);
  assert.equal(address('localhost'), 'localhost:8443');
});

test('every release has its notes', async () => {
  for (const release of [1, 2, 3, 4, 5]) {
    const notes = await readFile(
      new URL(`../notes/release-${release}.md`, import.meta.url),
      'utf8'
    );
    assert.ok(notes.length > 0, `notes/release-${release}.md is empty`);
  }
});
