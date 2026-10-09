import { expect, test } from 'vitest';
import { borrowHostAdmission, leaseHostAdmission } from '../src/admission-lease.js';

test('a selection closes once, after its last holder released, however often each releases', async () => {
  let closes = 0;
  const owner = leaseHostAdmission(() => {
    closes += 1;
  });
  const child = borrowHostAdmission(owner);
  await Promise.all([owner(), owner()]);
  // The owner's repeated release never spends the child's hold.
  expect(closes).toBe(0);
  await child?.();
  await child?.();
  expect(closes).toBe(1);
});

test('an admission without a selection lends nothing; a released or uncaptured one refuses', async () => {
  expect(borrowHostAdmission(undefined)).toBeUndefined();
  const owner = leaseHostAdmission(() => undefined);
  await owner();
  expect(() => borrowHostAdmission(owner)).toThrow('A released admission cannot be borrowed');
  expect(() => borrowHostAdmission(() => Promise.resolve())).toThrow(
    'A child can borrow only a captured admission'
  );
});
