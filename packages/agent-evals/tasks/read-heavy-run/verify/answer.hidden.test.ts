import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

test('answer.txt holds the password', async () => {
  const answer = await readFile(join(import.meta.dirname, '..', 'answer.txt'), 'utf8');
  assert.equal(answer.trim(), 'heliotrope-41');
});
