/** The current native index supplies candidates; the existing grep service owns line matching. */
import { refusalError } from '@brainstrike/assistant-contract';
import { GrepSearchService } from '@brainstrike/db';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
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
        // Refusals are typed so their reason crosses Main's boundary to the model;
        // a plain Error arrives as an untyped fault behind a generic tool error.
        if (status.kind !== 'ready') {
          throw refusalError('availability', 'native-grep.index-unavailable', status.reason);
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
        return found.hits.map((hit) => {
          if (
            hit.rootId === null ||
            hit.relativePath === null ||
            !rootIds.includes(hit.rootId) ||
            (collection !== undefined && hit.embeddingSetId !== collection) ||
            (selection.filePaths !== undefined && !selection.filePaths.includes(hit.relativePath))
          ) {
            throw new Error('Native grep returned a file outside its requested scope.');
          }
          return {
            chunkId: hit.chunkId,
            content: hit.content,
            endLine: hit.endLine,
            filePath: hit.relativePath,
            rootId: hit.rootId,
            startLine: hit.startLine,
          };
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
