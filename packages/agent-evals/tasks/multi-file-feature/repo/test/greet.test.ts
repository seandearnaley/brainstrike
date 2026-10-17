import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greet } from '../src/greet.ts';

test('greet says hello by name', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
});
