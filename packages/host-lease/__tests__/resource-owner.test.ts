import { expect, test } from 'vitest';
import { ResourceOwner } from '../src/resource-owner.js';

test('a failed finalizer never skips another owned resource and its original cause remains visible', async () => {
  const owner = new ResourceOwner();
  const released: string[] = [];
  const cause = new Error('resource release failed');
  await owner.acquire(
    async () => 'lease',
    async (value) => {
      released.push(value);
    }
  );
  await owner.acquire(
    async () => 'socket',
    async (value) => {
      released.push(value);
      throw cause;
    }
  );
  await expect(owner.close()).rejects.toBe(cause);
  expect(released).toEqual(['socket', 'lease']);
  await expect(owner.close()).rejects.toBe(cause);
  await expect(
    owner.acquire(
      async () => 'new',
      async () => undefined
    )
  ).rejects.toThrow(/closing/);
});
