import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commands } from '../src/registry.generated.ts';

test('the greet command says hello by name', () => {
  assert.equal(commands.greet('Ada'), 'Hello, Ada!');
});
