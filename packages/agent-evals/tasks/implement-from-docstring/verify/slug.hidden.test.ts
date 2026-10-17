import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slug.ts';

test('the documented example', () => {
  assert.equal(slugify('  Hello, World! 2026 '), 'hello-world-2026');
});

test('runs of other characters become one hyphen', () => {
  assert.equal(slugify('a -- b __ c'), 'a-b-c');
});

test('no hyphen at either end', () => {
  assert.equal(slugify('...Edge cases...'), 'edge-cases');
});

test('non-ASCII letters are other characters', () => {
  assert.equal(slugify('Crème brûlée'), 'cr-me-br-l-e');
});

test('a title with no letters or digits has the empty slug', () => {
  assert.equal(slugify('!!! ???'), '');
  assert.equal(slugify(''), '');
});

test('an existing slug is unchanged', () => {
  assert.equal(slugify('already-a-slug-42'), 'already-a-slug-42');
});
