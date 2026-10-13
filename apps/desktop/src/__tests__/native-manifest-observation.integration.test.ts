// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { fixture, records } from './native-index-catalog-refresh-fixture';

it.each(['discovery', 'newer', 'reverted'] as const)(
  'joins initial workspace publication before observing its %s catalog',
  async (change) => {
    const test = await fixture(true, true);
    test.state.holdWorkspaceProof = true;
    const opening = test.activation.acquire().catch((error: unknown) => error);
    try {
      await Promise.race([
        test.workspaceEntered.promise,
        opening.then((result) => {
          throw result ?? new Error('Opening settled before verification');
        }),
      ]);
      expect(test.proofs.at(-1)).toMatchObject({
        changed: [],
        complete: true,
        missing: [],
        unexpected: [],
      });
      let readSettled = false;
      const reading = test.activation.acquireRead().then(
        (port) => {
          readSettled = true;
          return port;
        },
        (error: unknown) => {
          readSettled = true;
          return error;
        }
      );
      await test.sawSingleInventory.promise;
      // Drain Main's catalog read continuation while the real SQLite verification is held.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(readSettled).toBe(false);
      expect(
        (await test.activation.getSearchAuthority()).readiness.every((row) => row.scanComplete)
      ).toBe(false);
      const discovered = test.state.files;
      let later: Promise<unknown> | undefined;
      if (change !== 'discovery') {
        test.state.files = [...discovered, ...records(1)];
        later = test.activation.acquireRead().catch((error: unknown) => error);
        await test.sawNewInventory.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (change === 'reverted') {
          test.state.files = discovered;
        }
      }
      test.state.holdWorkspaceProof = false;
      test.workspaceGate.resolve();
      expect(await reading).not.toBeInstanceOf(Error);
      expect(await opening).not.toBeInstanceOf(Error);
      expect(await later).not.toBeInstanceOf(Error);
      expect
        .soft(test.workspaceReceipts[0])
        .toMatchObject({ reason: 'complete', scanComplete: true });
      expect.soft(test.onError).not.toHaveBeenCalled();
      await test.activation.acquire();
      await vi.waitFor(async () =>
        expect(
          (await test.activation.getSearchAuthority()).readiness.every((row) => row.scanComplete)
        ).toBe(true)
      );
      expect(test.onError).not.toHaveBeenCalled();
      expect(test.bindings.at(-1)).toEqual([
        discovered[0]!.fileId,
        ...(change === 'newer' ? ['retained-0'] : []),
      ]);
    } finally {
      test.workspaceGate.resolve();
      await opening;
      await test.close();
    }
  }
);
