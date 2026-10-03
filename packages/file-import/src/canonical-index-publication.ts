import type { IndexerTextPublication } from '@brainstrike/indexing-contract/indexer-producer';
import type { CanonicalChunkEvent } from './canonical-chunk-producer.js';
import { toFileSymbolInserts } from './canonical-symbol-inserts.js';

export type CanonicalIndexPayload = Pick<
  IndexerTextPublication,
  'content' | 'fileId' | 'providedChunks' | 'syntax'
>;

/** Preserve the existing canonical event; invalid source/results never fall back to line chunks. */
export function canonicalIndexPublication(
  event: CanonicalChunkEvent,
  scope: { readonly rootId: string; readonly relativePath: string }
): IndexerTextPublication {
  return { ...canonicalIndexPayload(event), ...scope };
}

/** Scope metadata comes from the PG catalog; rootless collections need no fake root/path. */
export function canonicalIndexPayload(event: CanonicalChunkEvent): CanonicalIndexPayload {
  validateCanonicalEvent(event);
  const syntax = canonicalSyntax(event);
  return {
    content: event.source.content,
    fileId: event.source.fileRecordId,
    providedChunks: event.kind === 'worker-result' ? event.result.chunks : [],
    ...(syntax === undefined ? {} : { syntax }),
  };
}
function validateCanonicalEvent(event: CanonicalChunkEvent): void {
  const { source } = event;
  if (event.kind === 'empty-source' && source.content !== '') {
    throw new Error('Empty-source event carries nonempty canonical content.');
  }
  if (event.kind === 'worker-result') {
    if (event.result.fileRecordId !== source.fileRecordId) {
      throw new Error('Canonical worker result/source file identity differs.');
    }
    if (event.result.skipped && (source.content !== '' || event.result.chunks.length !== 0)) {
      throw new Error(
        `Canonical chunking skipped: ${event.result.skipReason ?? 'unspecified reason'}`
      );
    }
    if ((event.result.sourceRangeSkippedChunks ?? 0) !== 0) {
      throw new Error('Canonical chunk source ranges are incomplete; native file commit refused.');
    }
  }
}
function canonicalSyntax(
  event: CanonicalChunkEvent
): ReturnType<typeof toFileSymbolInserts> | undefined {
  const result = event.kind === 'worker-result' ? event.result : undefined;
  const syntax =
    result && (result.symbols !== undefined || result.symbolRefs !== undefined)
      ? toFileSymbolInserts(
          event.source.fileRecordId,
          result.symbols ?? [],
          result.symbolRefs ?? []
        )
      : undefined;
  return syntax;
}
