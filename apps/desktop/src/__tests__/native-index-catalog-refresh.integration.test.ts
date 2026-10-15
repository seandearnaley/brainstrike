// @vitest-environment node
import { NativeIndexRefusalError } from '@brainstrike/assistant-service/node-native-text-services';
import { expect, it, vi } from 'vitest';
import { fixture, mocks, records, scope } from './native-index-catalog-refresh-fixture';

it.each([false, true])(
  'finishes the first retained addition with repeated reads=%s and a complete real native manifest',
  async (repoll) => {
    const test = await fixture();
    try {
      await test.activation.acquire();
      test.state.files = records(1);
      test.state.hold = true;
      await test.activation.acquireRead();
      await test.entered.promise;
      expect(test.proofs.at(-1)).toMatchObject({
        changed: [],
        complete: true,
        missing: [],
        unexpected: [],
      });
      if (repoll) {
        await test.activation.acquireRead();
        await test.activation.acquireRead();
      }
      let joined = false;
      const joining = repoll
        ? test.activation
            .acquire()
            .then(() => {
              joined = true;
            })
            .catch((error: unknown) => error)
        : undefined;
      await Promise.resolve();
      expect(joined).toBe(false);
      test.gate.resolve();
      const receipt = await test.finished.promise;
      expect(receipt).toMatchObject({ reason: 'complete', scanComplete: true });
      await test.activation.acquire();
      expect(await joining).toBeUndefined();
      test.expectReadiness((await test.activation.getSearchAuthority()).readiness, [
        { generation: 2, mutationRevision: 2, scanComplete: true, scope },
      ]);
      expect(test.receipts).toHaveLength(2);
      expect(test.manifests).toEqual([[], [], ['retained-0']]);
      expect(test.onError).not.toHaveBeenCalled();
      expect(
        (
          await test.native.searchScopes({
            limit: 10,
            mode: 'bm25',
            scopes: [scope],
            text: 'marker',
          })
        ).hits.map((hit) => hit.fileId)
      ).toEqual(['retained-0']);
    } finally {
      await test.close();
    }
  }
);

it('answers reads during the old verified scan, gates every readiness projection on the queued inventory, then applies it (BST-2012)', async () => {
  const test = await fixture();
  try {
    await test.activation.acquire();
    test.state.files = records(1);
    test.state.hold = true;
    test.state.holdNext = true;
    await test.activation.acquireRead();
    await test.entered.promise;
    expect(test.proofs.at(-1)).toMatchObject({
      changed: [],
      complete: true,
      missing: [],
      unexpected: [],
    });
    test.state.files = records(2);
    // A read never waits for the running scan: it answers from the committed
    // catalog, and readiness reports the queued inventory as incomplete.
    expect(await test.activation.acquireRead()).toHaveProperty('info');
    await test.sawNewInventory.promise;
    expect(await test.capability.status()).toMatchObject({
      collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: false }],
      kind: 'ready',
    });
    test.expectReadiness((await test.activation.getSearchAuthority()).readiness, [
      { generation: 2, mutationRevision: 2, scanComplete: false, scope },
    ]);
    expect(test.bindings.at(-1)).toEqual(['retained-0']);
    test.gate.resolve();
    expect(await test.finished.promise).toMatchObject({ reason: 'complete', scanComplete: true });
    // The old scan settled, so the queued inventory is applied and scanned.
    await test.nextEntered.promise;
    test.expectReadiness(test.activation.getReadiness(), [
      { generation: 3, mutationRevision: 5, scanComplete: false, scope },
    ]);
    expect(await test.activation.acquireRead()).toHaveProperty('info');
    test.expectReadiness((await test.activation.getSearchAuthority()).readiness, [
      { generation: 3, mutationRevision: 5, scanComplete: false, scope },
    ]);
    expect(test.bindings.at(-1)).toEqual(['retained-0', 'retained-1']);
    test.nextGate.resolve();
    await test.activation.acquire();
    expect(await test.capability.status()).toMatchObject({
      collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: true }],
      kind: 'ready',
    });
    expect(test.receipts).toHaveLength(3);
    expect(test.receipts.every((receipt) => receipt.scanComplete)).toBe(true);
    expect(test.manifests).toEqual([[], [], ['retained-0'], ['retained-0', 'retained-1']]);
    expect(test.proofs.at(-1)).toMatchObject({
      changed: [],
      complete: true,
      missing: [],
      unexpected: [],
    });
    test.expectReadiness(test.activation.getReadiness(), [
      { generation: 3, mutationRevision: 5, scanComplete: true, scope },
    ]);
    test.expectReadiness((await test.activation.getSearchAuthority()).readiness, [
      { generation: 3, mutationRevision: 5, scanComplete: true, scope },
    ]);
    expect(test.onError).not.toHaveBeenCalled();
  } finally {
    await test.close();
  }
});
it.each([false, true])(
  'refuses an actually missing native row through the actual host/channel with newer inventory=%s',
  async (newer) => {
    const test = await fixture();
    try {
      await test.activation.acquire();
      test.state.files = records(1);
      test.state.hold = true;
      test.state.removeNativeFile = true;
      await test.activation.acquireRead();
      await test.entered.promise;
      await test.activation.acquireRead();
      expect(test.proofs.at(-1)).toMatchObject({
        complete: false,
        missing: [expect.objectContaining({ fileId: 'retained-0' })],
      });
      const updating = newer
        ? (() => {
            test.state.files = records(2);
            return test.activation.acquireRead().catch((error: unknown) => error);
          })()
        : undefined;
      if (newer) {
        await test.sawNewInventory.promise;
        await test.activation.getSearchAuthority();
      }
      test.gate.resolve();
      expect(await test.finished.promise).toMatchObject({
        reason: 'manifest-mismatch',
        scanComplete: false,
      });
      await updating;
      await vi.waitFor(() => expect(test.onError).toHaveBeenCalled());
      const blocked = await test.activation.acquireRead().catch((error: unknown) => error);
      expect(blocked).toBeInstanceOf(NativeIndexRefusalError);
      expect(blocked).toHaveProperty('cause', test.onError.mock.calls.at(-1)?.[1]);
      expect(test.manifests).toEqual([[], [], ['retained-0']]);
    } finally {
      await test.close();
    }
  }
);

it('observes catalog population before the initial collection scan so concurrent reads preserve its complete native receipt', async () => {
  const test = await fixture();
  try {
    test.state.populateOnAttachment = true;
    test.state.hold = true;
    const starting = test.activation.acquire().catch((error: unknown) => error);
    await test.entered.promise;
    await test.activation.acquireRead();
    await test.activation.acquireRead();
    expect(test.proofs.at(-1)).toMatchObject({
      changed: [],
      complete: true,
      missing: [],
      unexpected: [],
    });
    test.gate.resolve();
    expect(await test.finished.promise).toMatchObject({ reason: 'complete', scanComplete: true });
    expect(await starting).toHaveProperty('info');
    expect(test.manifests).toEqual([[], ['retained-0']]);
    expect(test.onError).not.toHaveBeenCalled();
    test.expectReadiness((await test.activation.getSearchAuthority()).readiness, [
      { generation: 1, mutationRevision: 2, scanComplete: true, scope },
    ]);
  } finally {
    await test.close();
  }
});
it.each([false, true])(
  'preserves genuine aggregate verification failure across the actual host/channel with newer inventory=%s',
  async (newer) => {
    const test = await fixture();
    try {
      await test.activation.acquire();
      test.state.files = records(1);
      test.state.hold = true;
      await test.activation.acquireRead();
      await test.entered.promise;
      test.state.nativeFailure = new AggregateError(
        [new Error('independent writer failure')],
        'genuine verification failure',
        { cause: new Error('original verification cause') }
      );
      const updating = newer
        ? (() => {
            test.state.files = records(2);
            return test.activation.acquireRead().catch((error: unknown) => error);
          })()
        : undefined;
      if (newer) {
        await test.sawNewInventory.promise;
        await test.activation.getSearchAuthority();
      }
      test.gate.resolve();
      await updating;
      await vi.waitFor(() => expect(test.onError).toHaveBeenCalled());
      expect(test.onError.mock.calls[0]?.[1]).toMatchObject({
        cause: expect.objectContaining({ message: 'original verification cause' }),
        errors: [expect.objectContaining({ message: 'independent writer failure' })],
        message: 'genuine verification failure',
      });
      await expect(test.activation.acquireRead()).rejects.toBe(test.onError.mock.calls[0]?.[1]);
      expect(test.manifests).toEqual([[], [], ['retained-0']]);
      test.expectReadiness(test.activation.getReadiness(), [
        { generation: 2, mutationRevision: 2, scanComplete: false, scope },
      ]);
    } finally {
      await test.close();
    }
  }
);

it('clears a queued inventory that reverts before the old verified scan settles without leaving readiness gated', async () => {
  const test = await fixture();
  try {
    await test.activation.acquire();
    test.state.files = records(1);
    test.state.hold = true;
    await test.activation.acquireRead();
    await test.entered.promise;
    test.state.files = records(2);
    expect(await test.activation.acquireRead()).toHaveProperty('info');
    await test.sawNewInventory.promise;
    await test.activation.getSearchAuthority();
    test.state.files = records(1);
    expect(await test.activation.acquireRead()).toHaveProperty('info');
    test.expectReadiness(test.activation.getReadiness(), [
      { generation: 2, mutationRevision: 2, scanComplete: false, scope },
    ]);
    test.gate.resolve();
    expect(await test.finished.promise).toMatchObject({ reason: 'complete', scanComplete: true });
    await vi.waitFor(() =>
      test.expectReadiness(test.activation.getReadiness(), [
        { generation: 2, mutationRevision: 2, scanComplete: true, scope },
      ])
    );
    expect(test.manifests).toEqual([[], [], ['retained-0']]);
    expect(test.bindings.at(-1)).toEqual(['retained-0']);
    expect(test.onError).not.toHaveBeenCalled();
  } finally {
    await test.close();
  }
});
it.each([false, true])(
  'keeps the admitted real native inventory during catalog loading with newer inventory=%s',
  async (newer) => {
    const test = await fixture();
    try {
      await test.activation.acquire();
      test.state.files = records(1);
      test.state.holdBatch = true;
      await test.activation.acquireRead();
      await test.batchEntered.promise;
      if (newer) {
        test.state.files = records(2);
      }
      const joining = test.activation.acquire().catch((error: unknown) => error);
      if (newer) {
        await test.sawNewInventory.promise;
        test.expectReadiness(test.activation.getReadiness(), [
          { generation: 2, mutationRevision: 1, scanComplete: false, scope },
        ]);
      }
      expect(test.bindings.at(-1)).toEqual(['retained-0']);
      test.batchGate.resolve();
      expect(await joining).toHaveProperty('info');
      expect(test.onError).not.toHaveBeenCalled();
      expect(test.manifests).toEqual(
        newer ? [[], [], ['retained-0'], ['retained-0', 'retained-1']] : [[], [], ['retained-0']]
      );
      expect(test.receipts.every((receipt) => receipt.scanComplete)).toBe(true);
      test.expectReadiness((await test.activation.getSearchAuthority()).readiness, [
        { generation: newer ? 3 : 2, mutationRevision: newer ? 5 : 2, scanComplete: true, scope },
      ]);
    } finally {
      await test.close();
    }
  }
);

it('uses one snapshot for admission, bindings and source inventory when PG changes during admission loading', async () => {
  const test = await fixture();
  try {
    await test.activation.acquire();
    test.state.files = records(1);
    test.state.holdInventoryAfterReads = 1;
    const initial = test.activation.acquireRead().catch((error: unknown) => error);
    await test.inventoryEntered.promise;
    test.state.files = records(2);
    const latest = test.activation.acquire().catch((error: unknown) => error);
    await test.sawNewInventory.promise;
    test.inventoryGate.resolve();
    expect(await initial).toHaveProperty('info');
    expect(await latest).toHaveProperty('info');
    expect(test.manifests).toEqual([[], [], ['retained-0'], ['retained-0', 'retained-1']]);
    expect(test.receipts.every((receipt) => receipt.scanComplete)).toBe(true);
    expect(test.onError).not.toHaveBeenCalled();
  } finally {
    await test.close();
  }
});

it('drains a real workspace pass through the private-channel receipt before collection loading', async () => {
  const test = await fixture(true);
  try {
    await test.activation.acquire();
    test.state.holdWorkspace = true;
    await test.triggerWorkspace();
    await test.workspaceEntered.promise;
    test.state.files = records(1);
    const refresh = test.activation.acquire().catch((error: unknown) => error);
    await test.sawSingleInventory.promise;
    await test.native.info();
    expect(test.bindings).toEqual([]);
    expect(test.receipts).toHaveLength(1);
    test.workspaceGate.resolve();
    expect(await refresh).toHaveProperty('info');
    expect(test.workspaceReceipts).toHaveLength(2);
    expect(test.manifests).toContainEqual(['retained-0']);
    expect(test.onError).not.toHaveBeenCalled();
  } finally {
    await test.close();
  }
});

it('admits a later real workspace pass only after the owned collection host/channel settles', async () => {
  const test = await fixture(true);
  try {
    await test.activation.acquire();
    const count = test.workspaceBegins.length;
    test.state.files = records(1);
    test.state.holdBatch = true;
    await test.activation.acquireRead();
    await test.batchEntered.promise;
    test.state.observeWorkspaceInventory = true;
    await test.triggerWorkspace();
    await test.workspaceInventorySeen.promise;
    await test.native.info();
    expect(test.state.workspaceLoading).toBe(true);
    expect(test.workspaceBegins).toHaveLength(count);
    test.batchGate.resolve();
    await test.activation.acquire();
    await vi.waitFor(() => expect(test.workspaceReceipts).toHaveLength(2));
    expect(test.workspaceBegins).toHaveLength(count + 1);
    expect(test.receipts.every((receipt) => receipt.scanComplete)).toBe(true);
    expect(test.onError).not.toHaveBeenCalled();
  } finally {
    await test.close();
  }
});

it.each([false, true])(
  'owns pending startup coverage across binding admission (progress=%s)',
  async (progress) => {
    const test = await fixture();
    test.state.holdAttachment = true;
    test.state.holdCoverage = true;
    test.state.populateOnAttachment = progress;
    test.state.hold = progress;
    try {
      expect(await test.capability.status()).toMatchObject({
        collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: false }],
        kind: 'ready',
      });
      await test.attachmentEntered.promise;
      const pending = test.capability
        .coverage({ collectionId: 'selected', rootIds: [] })
        .catch((error: unknown) => error);
      await test.coverageEntered.promise;
      const before = test.authorities.at(-1);
      const beforeStore = (await test.native.info()).storeId;
      const beforeNative = await test.native.coverageAuthority();
      test.attachmentGate.resolve();
      if (progress) {
        await test.sawSingleInventory.promise;
      } else {
        await test.activation.acquire();
      }
      const after = await test.activation.getSearchAuthority();
      const fields = [
        'generation',
        'collectionId',
        'rootIds',
        'bindings',
        'profile',
        'queryPlan',
      ] as const;
      expect(
        fields.filter((field) => JSON.stringify(before?.[field]) !== JSON.stringify(after[field]))
      ).toEqual(progress ? ['bindings'] : []);
      expect((await test.native.info()).storeId).toBe(beforeStore);
      expect(test.bindings.flat()).not.toContain('retained-0');
      expect(test.receipts).toHaveLength(progress ? 0 : 1);
      test.coverageGate.resolve();
      const observation = await pending;
      if (progress) {
        expect(observation).toMatchObject({
          storeId: beforeStore,
          totals: { chunks: 0, indexedFiles: 0 },
        });
      } else {
        expect(observation).toMatchObject({
          storeId: beforeStore,
          totals: { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 },
          vectorCoverageComplete: false,
        });
        const currentNative = await test.native.coverageAuthority();
        expect(currentNative).toEqual(beforeNative);
        expect(before?.readiness).toEqual([
          { generation: 0, mutationRevision: 0, scanComplete: false, scope },
        ]);
        expect(after.readiness).toEqual([
          { generation: 1, mutationRevision: 0, scanComplete: true, scope },
        ]);
        expect(currentNative.fileBindings).toEqual([]);
        expect(
          await test.capability.coverage({ collectionId: 'selected', rootIds: [] })
        ).toMatchObject({
          storeId: beforeStore,
          totals: { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 },
          vectorCoverageComplete: false,
        });
        test.expectReadiness(test.activation.getReadiness(), [
          { generation: 1, mutationRevision: 0, scanComplete: true, scope },
        ]);
        expect(await test.native.coverageAuthority()).toEqual(currentNative);
      }
      expect(test.authorities.at(-1)?.bindings).toEqual(before?.bindings);
      if (progress) {
        await test.entered.promise;
        expect(test.bindings.flat()).toContain('retained-0');
        expect(test.receipts).toHaveLength(0);
      }
      test.gate.resolve();
      await test.activation.acquire();
      expect(test.onError).not.toHaveBeenCalled();
      test.expectReadiness(test.activation.getReadiness(), [
        { generation: 1, mutationRevision: progress ? 2 : 0, scanComplete: true, scope },
      ]);
    } finally {
      await test.close();
    }
  }
);

it('rejects held native coverage when genuine saved authority replacement retires its owner', async () => {
  const test = await fixture();
  try {
    await test.activation.acquire();
    test.state.holdCoverage = true;
    const pending = test.capability
      .coverageBatch([{ collectionId: 'selected', rootIds: [] }])
      .catch((error: unknown) => error);
    await test.coverageEntered.promise;
    const originalStore = (await test.native.info()).storeId;
    const closedBefore = mocks.coverageClosed.mock.calls.length;
    test.state.enabled = false;
    const replacing = test.activation.reconfigure().catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(() => test.activation.captureAcknowledgedAuthority()).toThrow(
        'Native source authority changed'
      )
    );
    expect(mocks.close).not.toHaveBeenCalled();
    expect((await test.native.info()).storeId).toBe(originalStore);
    await expect(test.activation.withRead(async () => {})).rejects.toThrow(
      'Native index is transitioning.'
    );
    expect(mocks.coverageClosed).toHaveBeenCalledTimes(closedBefore);
    test.coverageGate.resolve();
    expect(await pending).toEqual({
      cause: { kind: 'transitioning' },
      code: 'native-coverage-observation-invalidated',
      kind: 'invalidated',
    });
    expect(mocks.coverageClosed).toHaveBeenCalledTimes(closedBefore + 1);
    expect(await replacing).toEqual(new Error('Native indexing is disabled in saved settings.'));
    expect(mocks.close).toHaveBeenCalledOnce();
  } finally {
    await test.close();
  }
});
