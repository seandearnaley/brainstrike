import { describe, expect, it, vi } from 'vitest';
import { prepareFactoryReset, registerFactoryResetPreparation } from '../factory-reset.ts';

describe('factory reset preparation', () => {
  it('starts every owner and joins their admitted work before returning', async () => {
    const pending = Promise.withResolvers<void>();
    const otherOwner = vi.fn(async () => {});
    const removeFirst = registerFactoryResetPreparation(() => pending.promise);
    const removeOther = registerFactoryResetPreparation(otherOwner);
    let prepared = false;
    const preparation = prepareFactoryReset().then(() => {
      prepared = true;
    });
    try {
      expect(otherOwner).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(prepared).toBe(false);
      pending.resolve();
      await preparation;
      expect(prepared).toBe(true);
    } finally {
      pending.resolve();
      removeFirst();
      removeOther();
    }
  });

  it('retains every preparation failure and removes disposed registrations', async () => {
    const first = new Error('workspace save failed');
    const second = new Error('another owner failed');
    const removeFirst = registerFactoryResetPreparation(async () => {
      throw first;
    });
    const removeSecond = registerFactoryResetPreparation(async () => {
      throw second;
    });
    try {
      await expect(prepareFactoryReset()).rejects.toMatchObject({ errors: [first, second] });
    } finally {
      removeFirst();
      removeSecond();
    }
    await expect(prepareFactoryReset()).resolves.toBeUndefined();
  });
});
