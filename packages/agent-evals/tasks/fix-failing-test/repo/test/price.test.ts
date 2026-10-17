import assert from 'node:assert/strict';
import { test } from 'node:test';
import { totalWithDiscount } from '../src/price.ts';

test('a 25% discount takes a quarter off the total', () => {
  assert.equal(totalWithDiscount([1000, 3000], 25), 3000);
});
