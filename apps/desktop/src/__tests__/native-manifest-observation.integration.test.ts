// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { fixture, records } from './native-index-catalog-refresh-fixture';

it.each(['discovery', 'newer', 'reverted'] as const)(
  'answers reads during initial workspace publication, then observes its %s catalog (BST-2012)',
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
      // A read answers from the committed catalog while the real SQLite verification
      // is held, and readiness reports the publication as incomplete.
      expect(await test.activation.acquireRead()).not.toBeInstanceOf(Error);
      await test.sawSingleInventory.promise;
      expect(
        (await test.activation.getSearchAuthority()).readiness.every((row) => row.scanComplete)
      ).toBe(false);
      const discovered = test.state.files;
      if (change !== 'discovery') {
        test.state.files = [...discovered, ...records(1)];
        expect(await test.activation.acquireRead()).not.toBeInstanceOf(Error);
        await test.sawNewInventory.promise;
        if (change === 'reverted') {
          test.state.files = discovered;
        }
      }
      test.state.holdWorkspaceProof = false;
      test.workspaceGate.resolve();
      expect(await opening).not.toBeInstanceOf(Error);
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
