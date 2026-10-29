import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import type { IndexerCoverageBatch } from '@brainstrike/indexing-contract/indexer-client';
import { useEffect, useState } from 'react';
import { completeScopeReceipts } from '../core/native-workspace-search';
import type { NativeWorkspaceSearchDependencies } from '../core/native-workspace-search-context';
import type { SearchCoverageBannerProps } from './search-coverage-banner';

function describeCoverage(batch: IndexerCoverageBatch, rootIds: readonly string[]): string | null {
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
  if (!completeScopeReceipts(batch.status, rootIds)) {
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
}: SearchCoverageBannerProps & { native: NativeWorkspaceSearchDependencies }) {
  const { capability, status } = native;
  // A folder the index leaves out has no coverage to report; the search names it.
  const indexedRootIds =
    status?.kind === 'ready'
      ? rootIds.filter((rootId) => status.authorizedRootIds.includes(rootId))
      : rootIds;
  const nothingIndexed = rootIds.length > 0 && indexedRootIds.length === 0;
  const scopeKey = JSON.stringify(indexedRootIds);
  const [result, setResult] = useState<{
    capability: typeof capability;
    status: typeof status;
    scopeKey: string;
    text: string | null;
  } | null>(null);
  // The existing producer observation invalidates this read; no polling.
  useEffect(() => {
    let active = true;
    if (!capability || status?.kind === 'unavailable' || nothingIndexed) {
      return;
    }
    const requestedRoots: string[] = JSON.parse(scopeKey);
    capability
      .coverageBatch([{ rootIds: requestedRoots }])
      .then((batch) => describeCoverage(batch, requestedRoots))
      .then(
        (text) => {
          if (active) {
            setResult({ capability, scopeKey, status, text });
          }
        },
        (cause: unknown) => {
          if (active) {
            setResult({
              capability,
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
  }, [capability, status, scopeKey, nothingIndexed]);
  const text = capability
    ? status?.kind === 'unavailable'
      ? status.reason
      : nothingIndexed
        ? null
        : result?.capability === capability &&
            result.status === status &&
            result.scopeKey === scopeKey
          ? result.text
          : 'Verifying index coverage…'
    : 'Native index capability is unavailable.';
  return text ? (
    <div className="bg-muted/40 text-muted-foreground rounded-md px-2 py-1 text-xs" role="status">
      {text}
    </div>
  ) : null;
}
