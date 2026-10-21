import { describe, expect, it } from 'vitest';
import {
  installMainBootFixture,
  mockApp,
  notesVaultCapture,
  shutdownPlanCapture,
} from './boot-order-fixture';

describe('Notes Vault shutdown ownership (BST-2248)', () => {
  installMainBootFixture();

  it.each([false, true])(
    'will-quit starts no native retry after cleanup failure=%s',
    async (fail) => {
      await import('../../main');
      const plan = shutdownPlanCapture.current?.();
      const close = notesVaultCapture.close;
      const willQuit = mockApp.on.mock.calls.find(([event]) => event === 'will-quit')?.[1];
      if (!(plan && close && typeof willQuit === 'function')) {
        throw new Error('Actual Main shutdown ownership was not captured');
      }
      const failure = new Error('Native unsubscribe failed');
      const heldRetry = Promise.withResolvers<void>();
      if (fail) {
        close.mockRejectedValueOnce(failure);
      } else {
        close.mockResolvedValueOnce(undefined);
      }
      close.mockReturnValueOnce(heldRetry.promise);
      const graceful = Promise.resolve(plan.steps['notes-vault']());
      if (fail) {
        await expect(graceful).rejects.toBe(failure);
      } else {
        await graceful;
      }
      try {
        willQuit();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(close).toHaveBeenCalledOnce();
      } finally {
        heldRetry.resolve();
      }
    }
  );
});
