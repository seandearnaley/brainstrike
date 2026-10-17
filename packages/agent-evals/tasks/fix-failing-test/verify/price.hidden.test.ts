import assert from 'node:assert/strict';
import { test } from 'node:test';
import { totalWithDiscount } from '../src/price.ts';

test('no discount keeps the total', () => {
  assert.equal(totalWithDiscount([199, 1], 0), 200);
});

test('a full discount is free', () => {
  assert.equal(totalWithDiscount([500], 100), 0);
});

test('the discounted total rounds to the nearest cent', () => {
  assert.equal(totalWithDiscount([333], 10), 300);
});

test('an empty cart costs nothing', () => {
  assert.equal(totalWithDiscount([], 50), 0);
});
