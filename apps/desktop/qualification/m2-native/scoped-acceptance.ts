import { expect } from '@playwright/test';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import {
  assertTextInferenceInactive,
  type NativeSnapshot,
  observeNativeSnapshot,
} from './candidate';
import { waitForCurrentObservation } from './coverage-observation';
import { assertActualVectorWorker } from './vector-profile';

interface ScopeCounts {
  readonly mode: 'TEXT' | 'VECTOR';
  readonly workspace: number;
}

function scopesComplete(snapshot: NativeSnapshot | null, counts: ScopeCounts): boolean {
  if (snapshot?.status.kind !== 'ready') {
    return false;
  }
  const { status, coverage } = snapshot;
  if (status.rootReadiness.some((receipt) => !receipt.scanComplete)) {
    return false;
  }
  const fields = ['chunks', 'indexedFiles', 'missingVectors', 'vectors'] as const;
  if (counts.workspace === 0) {
    return status.authorizedRootIds.length === 0;
  }
  if (
    !coverage ||
    status.authorizedRootIds.length !== 1 ||
    coverage.roots.length !== 1 ||
    coverage.roots[0]?.rootId !== status.authorizedRootIds[0] ||
    coverage.storeId !== status.storeId ||
    coverage.totals.indexedFiles !== counts.workspace ||
    !fields.every((key) => coverage.roots[0]?.[key] === coverage.totals[key])
  ) {
    return false;
  }
  return counts.mode === 'TEXT'
    ? coverage.embedding.indexMode === 'text-only' && coverage.totals.vectors === 0
    : coverage.embedding.indexMode === 'vector-configured' &&
        coverage.vectorCoverageComplete &&
        coverage.totals.chunks > 0 &&
        coverage.totals.missingVectors === 0 &&
        coverage.totals.vectors === coverage.totals.chunks;
}

export async function waitForScopes(
  context: ElectronAppContext,
  counts: ScopeCounts,
  options: { readonly requireVectorWorker: boolean } = { requireVectorWorker: true }
): Promise<NativeSnapshot> {
  const snapshot = await waitForCurrentObservation(
    () => observeNativeSnapshot(context),
    (read) =>
      expect
        .poll(async () => scopesComplete(await read(), counts), {
          message:
            'Actual current scoped complete receipts and canonical row/vector counts must agree',
          timeout: counts.mode === 'VECTOR' ? 480_000 : 90_000,
        })
        .toBe(true)
  );
  if (counts.mode === 'TEXT') {
    assertTextInferenceInactive(snapshot);
  } else if (options.requireVectorWorker) {
    assertActualVectorWorker(snapshot);
  }
  return snapshot;
}
