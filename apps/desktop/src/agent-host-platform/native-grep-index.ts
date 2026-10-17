/** The current native index supplies candidates; the existing grep service owns line matching. */
import { refusalError } from '@brainstrike/assistant-contract';
import {
  type IndexSearchCapability,
  indexerStatusFailure,
} from '@brainstrike/indexing-contract/indexer-client';
import { isWorkspaceSecretFile } from '@brainstrike/utils';
import { GrepSearchService } from '@brainstrike/utils/grep-search';
import type { GrepIndexSearch } from '../assistant-server/grep-search-core';

function hasNoConfiguredIndex(
  status: Awaited<ReturnType<IndexSearchCapability['status']>>,
  collectionId: string | undefined
): boolean {
  return (
    status.kind === 'unavailable' && status.phase === 'setup-required' && collectionId === undefined
  );
}

export function nativeGrepIndex(
  index: Pick<IndexSearchCapability, 'grep' | 'status'>
): GrepIndexSearch {
  return async (options) => {
    let candidatesTruncated = false;
    let scanLimited = false;
    const result = await new GrepSearchService({
      findGrepCandidates: async (selection) => {
        const status = await index.status();
        // A fresh profile contributes no indexed candidates to the existing
        // live-file grep. Configured or explicitly selected indexes still refuse.
        if (hasNoConfiguredIndex(status, options.embeddingSetId)) {
          return [];
        }
        // A typed index cause crosses Main's boundary as its fixed refusal text
        // and remedy, which reach the model; a plain Error stays a generic fault.
        if (status.kind !== 'ready') {
          throw indexerStatusFailure(status);
        }
        const collection = options.embeddingSetId;
        if (collection !== undefined && !status.authorizedCollectionIds?.includes(collection)) {
          throw refusalError(
            'input',
            'native-grep.collection-unauthorized',
            'The requested grep collection is not the current authorized collection.'
          );
        }
        const rootIds =
          options.rootId === undefined
            ? (options.rootIds ?? status.authorizedRootIds)
            : [options.rootId];
        const found = await index.grep({
          caseSensitive: options.caseSensitive ?? false,
          ...(selection.filePaths === undefined ? {} : { filePaths: selection.filePaths }),
          isRegex: options.isRegex ?? false,
          limit: selection.limit,
          pattern: options.pattern,
          rootIds,
        });
        candidatesTruncated = found.candidatesTruncated || found.truncated;
        scanLimited = found.scanLimited;
        return found.hits.flatMap((hit) => {
          if (
            hit.rootId === null ||
            hit.relativePath === null ||
            !rootIds.includes(hit.rootId) ||
            (collection !== undefined && hit.embeddingSetId !== collection) ||
            (selection.filePaths !== undefined && !selection.filePaths.includes(hit.relativePath))
          ) {
            throw new Error('Native grep returned a file outside its requested scope.');
          }
          // Indexing skips credential files, but a chunk stored before that
          // floor, or kept by a truncated reconciliation, still answers here.
          // Dropped before line matching, it never counts toward the totals.
          if (isWorkspaceSecretFile(hit.relativePath)) {
            return [];
          }
          return [
            {
              chunkId: hit.chunkId,
              content: hit.content,
              endLine: hit.endLine,
              filePath: hit.relativePath,
              rootId: hit.rootId,
              startLine: hit.startLine,
            },
          ];
        });
      },
    }).search({
      ...options,
      // The existing SQLite grep protocol admits at most 200 rows. Preserve its
      // truncation receipt instead of forwarding the legacy 500-row default.
      candidateLimit: Math.min(options.candidateLimit ?? 200, 200),
    });
    return {
      ...result,
      candidatesTruncated: result.candidatesTruncated || candidatesTruncated,
      scanLimited: result.scanLimited || scanLimited,
    };
  };
}
