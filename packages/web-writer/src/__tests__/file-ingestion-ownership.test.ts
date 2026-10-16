import { describe, expect, it } from 'vitest';
import { retireOwnedRoot } from '../file-ingestion';

describe("a retired root's place in the index", () => {
  it('is given up when its ingestion retires, so the next scan opens it afresh', async () => {
    const owned = Promise.resolve('root');
    const roots = new Map([['root', owned]]);
    await retireOwnedRoot(roots, 'root', owned, async () => {});
    expect(roots.has('root')).toBe(false);
  });

  it('is kept by the failure when its retirement fails, and every later scan meets it', async () => {
    const owned = Promise.resolve('root');
    const roots = new Map([['root', owned]]);
    const failure = new Error('lease retirement failed');
    await expect(
      retireOwnedRoot(roots, 'root', owned, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    await expect(roots.get('root')).rejects.toBe(failure);
  });

  it("leaves another root's place alone", async () => {
    const owned = Promise.resolve('old');
    const replacement = Promise.resolve('new');
    const roots = new Map([['root', replacement]]);
    await expect(
      retireOwnedRoot(roots, 'root', owned, async () => {
        throw new Error('failed');
      })
    ).rejects.toThrow('failed');
    expect(roots.get('root')).toBe(replacement);
    await retireOwnedRoot(roots, 'root', owned, async () => {});
    expect(roots.get('root')).toBe(replacement);
  });
});
