import type {
  IndexerSourceObservation,
  IndexerStatus,
} from '@brainstrike/indexing-contract/indexer-client';

type Receipt = IndexerSourceObservation['readiness'][number];
function selectedReceipts(
  observation: IndexerSourceObservation,
  rootIds: readonly string[]
): readonly Receipt[] | null {
  const selected: Receipt[] = [];
  for (const rootId of rootIds) {
    const matches = observation.readiness.filter(
      ({ scope }) => scope.kind === 'workspace' && scope.rootId === rootId
    );
    if (matches.length !== 1 || !matches[0]) {
      return null;
    }
    selected.push(matches[0]);
  }
  return selected;
}

/** A completed producer proof can refresh a partial query once; unchanged polls cannot. */
export function nativeSourceCompletion(
  source: {
    readonly storeId: string;
    readonly observations: readonly IndexerSourceObservation[];
    readonly after?: IndexerSourceObservation;
  },
  status: IndexerStatus | undefined,
  rootIds: readonly string[]
): IndexerSourceObservation | null {
  if (status?.kind !== 'ready' || status.storeId !== source.storeId || !status.sourceObservation) {
    return null;
  }
  const current = status.sourceObservation;
  const receipts = selectedReceipts(current, rootIds);
  if (!receipts?.length || receipts.some((receipt) => !receipt.scanComplete)) {
    return null;
  }
  const consumed = source.after ? selectedReceipts(source.after, rootIds) : null;
  if (
    source.after?.ownerGeneration === current.ownerGeneration &&
    consumed?.every(
      (receipt, index) =>
        receipt.generation === receipts[index]?.generation &&
        receipt.mutationRevision === receipts[index]?.mutationRevision &&
        receipt.scanComplete === receipts[index]?.scanComplete
    )
  ) {
    return null;
  }
  for (const observed of source.observations) {
    if (current.ownerGeneration !== observed.ownerGeneration) {
      return null;
    }
    const prior = selectedReceipts(observed, rootIds);
    if (
      !prior ||
      prior.some((receipt, index) => {
        const next = receipts[index];
        return (
          !next ||
          next.generation < receipt.generation ||
          (next.generation === receipt.generation &&
            next.mutationRevision < receipt.mutationRevision)
        );
      })
    ) {
      return null;
    }
  }
  return current;
}
