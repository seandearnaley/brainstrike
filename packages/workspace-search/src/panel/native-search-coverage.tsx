import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import type { IndexerCoverageBatch } from '@brainstrike/indexing-contract/indexer-client';
import { useEffect, useState } from 'react';
import { completeScopeReceipts } from '../core/native-workspace-search';
import type { NativeWorkspaceSearchDependencies } from '../core/native-workspace-search-context';
import type { SearchCoverageBannerProps } from './search-coverage-banner';

function describeCoverage(
  batch: IndexerCoverageBatch,
  rootIds: readonly string[],
  collectionId: string | null
): string | null {
  if (batch.kind === 'invalidated') {
    return 'Verifying index coverage…';
  }
  if (batch.kind === 'blocked') {
    return batch.reason;
  }
  const [coverage] = batch.coverage;
  if (batch.coverage.length !== 1 || !coverage || coverage.storeId !== batch.status.storeId) {
    throw new Error('Native index coverage returned a different inventory.');
  }
  if (!completeScopeReceipts(batch.status, rootIds, collectionId)) {
    return 'Indexing…';
  }
  if (coverage.embedding.indexMode === 'vector-configured' && !coverage.vectorCoverageComplete) {
    return `Indexing… (${coverage.totals.vectors}/${coverage.totals.chunks} chunks)`;
  }
  return null;
}

/** A read projection of the native owner's same-observation coverage and publication receipts. */
export function NativeSearchCoverage({
  native,
  rootIds,
  collectionId,
}: SearchCoverageBannerProps & { native: NativeWorkspaceSearchDependencies }) {
  const { capability, status } = native;
  const scopeKey = JSON.stringify(rootIds);
  const [result, setResult] = useState<{
    capability: typeof capability;
    status: typeof status;
    scopeKey: string;
    collectionId: string | null;
    text: string | null;
  } | null>(null);
  // The existing producer observation invalidates this read; no polling or collection writer.
  useEffect(() => {
    let active = true;
    if (!capability || status?.kind === 'unavailable') {
      return;
    }
    const requestedRoots: string[] = JSON.parse(scopeKey);
    capability
      .coverageBatch([{ rootIds: requestedRoots, ...(collectionId ? { collectionId } : {}) }])
      .then((batch) => describeCoverage(batch, requestedRoots, collectionId))
      .then(
        (text) => {
          if (active) {
            setResult({ capability, collectionId, scopeKey, status, text });
          }
        },
        (cause: unknown) => {
          if (active) {
            setResult({
              capability,
              collectionId,
              scopeKey,
              status,
              text: describeBoundaryError(cause),
            });
          }
        }
      );
    return () => {
      active = false;
    };
  }, [capability, status, scopeKey, collectionId]);
  const text = capability
    ? status?.kind === 'unavailable'
      ? status.reason
      : result?.capability === capability &&
          result.status === status &&
          result.scopeKey === scopeKey &&
          result.collectionId === collectionId
        ? result.text
        : 'Verifying index coverage…'
    : 'Native index capability is unavailable.';
  return text ? (
    <div className="rounded-md bg-muted/40 px-2 py-1 text-muted-foreground text-xs" role="status">
      {text}
    </div>
  ) : null;
}
