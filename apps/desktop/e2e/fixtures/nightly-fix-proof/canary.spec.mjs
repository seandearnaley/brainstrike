import { expect, test } from '@playwright/test';
import { multiply } from './canary.mjs';

test('PROOF pv67-nonempty-20261020-v2: multiply(2, 3) must equal 6', () => {
  expect(multiply(2, 3)).toBe(6);
});
