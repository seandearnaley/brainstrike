/**
 * The thread context map's pure view model (ADR-0021, BST-2017): the fold's
 * calls at one turn, grouped by file, with each call's tokens spread over its
 * spans and each index chunk's coverage. No React, no IO.
 */
import {
  type ContextCallAtTurn,
  type ContextCallState,
  type ContextSpan,
  type ContextSpanKind,
  fileWindowTokens,
  type ThreadContextAtTurn,
} from '@brainstrike/assistant-ui/thread-context-fold';
import type { IndexerFileChunkBounds } from '@brainstrike/indexing-contract/indexer-client';

export type ContextMapMode = 'all' | 'window';

/** One span with the call that delivered it and its share of that call's tokens. */
export interface ContextFileSpan {
  readonly at: ContextCallAtTurn;
  /** This span's share of the call's first full delivery; null when unmeasured. */
  readonly deliveredTokens: number | null;
  readonly span: ContextSpan;
  /** This span's share of the call's tokens in the selected window; null when unknown. */
  readonly windowTokens: number | null;
}

export interface ContextFileRow {
  readonly deliveredTokens: number | null;
  /** An edit to lines no earlier span of this file delivered. */
  readonly editedWithoutRead: boolean;
  /** Every span delivered at most up to the selected turn has left the window. */
  readonly gone: boolean;
  readonly key: string;
  /** The largest line any span reached: the extent of a strip without index chunks. */
  readonly maxLine: number;
  readonly path: string;
  readonly rootId?: string;
  readonly rootName?: string;
  readonly spans: readonly ContextFileSpan[];
  readonly windowTokens: number | null;
}

export interface ContextMapTotals {
  readonly deliveredTokens: number | null;
  /** Calls without file spans (shell output, listings, failures). */
  readonly otherCalls: number;
  /** Tokens delivered more than once: delivered minus unique lines' share. */
  readonly rereadTokens: number;
  readonly unmappedCalls: number;
  readonly windowTokens: number | null;
}

const LIVE_STATES: ReadonlySet<ContextCallState> = new Set(['in-window', 'unknown']);

export function isLive(state: ContextCallState): boolean {
  return LIVE_STATES.has(state);
}

/** The drawing priority when spans of several kinds overlap one chunk. */
export const KIND_PRIORITY: Readonly<Record<ContextSpanKind, number>> = {
  edit: 5,
  grep: 1,
  pinned: 4,
  read: 3,
  semantic: 2,
};

export function fileKey(span: Pick<ContextSpan, 'path' | 'rootId' | 'rootName'>): string {
  return `${span.rootId ?? `name:${span.rootName ?? ''}`}\u0000${span.path}`;
}

function spanWeight(span: ContextSpan): number {
  return span.startLine !== undefined && span.endLine !== undefined
    ? span.endLine - span.startLine + 1
    : 1;
}

function share(tokens: number | null, weight: number, total: number): number | null {
  return tokens === null ? null : Math.round((tokens * weight) / Math.max(total, 1));
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) {
      return null;
    }
    total += value;
  }
  return total;
}

/** Lines `[start, end]` covered by `spans`, as a set of line numbers. */
function coveredLines(spans: readonly ContextSpan[], start = 1, end = Number.POSITIVE_INFINITY) {
  const lines = new Set<number>();
  for (const span of spans) {
    if (span.startLine === undefined || span.endLine === undefined) {
      continue;
    }
    for (
      let line = Math.max(span.startLine, start);
      line <= Math.min(span.endLine, end);
      line += 1
    ) {
      lines.add(line);
    }
  }
  return lines;
}

function editedWithoutRead(spans: readonly ContextFileSpan[]): boolean {
  return spans.some(({ at, span }) => {
    if (span.kind !== 'edit') {
      return false;
    }
    const earlier = spans.filter(
      (other) => other.at.turn <= at.turn && other.span.kind !== 'edit' && other.at !== at
    );
    if (earlier.some((other) => other.span.wholeFile)) {
      return false;
    }
    if (span.startLine === undefined || span.endLine === undefined) {
      return earlier.length === 0;
    }
    const seen = coveredLines(
      earlier.map((other) => other.span),
      span.startLine,
      span.endLine
    );
    return seen.size < span.endLine - span.startLine + 1;
  });
}

/** Group the turn's calls into file rows, largest first by the mode's measure. */
export function contextFileRows(
  calls: readonly ContextCallAtTurn[],
  mode: ContextMapMode
): ContextFileRow[] {
  const byFile = new Map<string, ContextFileSpan[]>();
  for (const at of calls) {
    const total = at.call.spans.reduce((sum, span) => sum + spanWeight(span), 0);
    for (const span of at.call.spans) {
      const weight = spanWeight(span);
      const entry: ContextFileSpan = {
        at,
        deliveredTokens: share(at.deliveredTokens, weight, total),
        span,
        windowTokens: share(at.windowTokens, weight, total),
      };
      const key = fileKey(span);
      const list = byFile.get(key);
      if (list) {
        list.push(entry);
      } else {
        byFile.set(key, [entry]);
      }
    }
  }
  const rows = [...byFile.entries()].map(([key, spans]): ContextFileRow => {
    const first = spans[0]?.span;
    return {
      deliveredTokens: sumOrNull(spans.map((entry) => entry.deliveredTokens)),
      editedWithoutRead: editedWithoutRead(spans),
      gone: spans.every((entry) => !isLive(entry.at.state)),
      key,
      maxLine: Math.max(1, ...spans.map((entry) => entry.span.endLine ?? 1)),
      path: first?.path ?? '',
      spans,
      windowTokens: sumOrNull(spans.map((entry) => entry.windowTokens)),
      ...(first?.rootId ? { rootId: first.rootId } : {}),
      ...(first?.rootName ? { rootName: first.rootName } : {}),
    };
  });
  const measure = (row: ContextFileRow) =>
    (mode === 'window' ? row.windowTokens : row.deliveredTokens) ?? -1;
  return rows.sort((a, b) => measure(b) - measure(a) || a.path.localeCompare(b.path));
}

export function contextMapTotals(
  view: ThreadContextAtTurn,
  rows: readonly ContextFileRow[]
): ContextMapTotals {
  const { calls } = view;
  let rereadTokens = 0;
  for (const row of rows) {
    const delivered = row.spans.filter((entry) => entry.deliveredTokens !== null);
    const deliveredLines = delivered.reduce((sum, entry) => sum + spanWeight(entry.span), 0);
    const unique = coveredLines(delivered.map((entry) => entry.span)).size;
    const tokens = delivered.reduce((sum, entry) => sum + (entry.deliveredTokens ?? 0), 0);
    if (deliveredLines > unique && deliveredLines > 0) {
      rereadTokens += Math.round((tokens * (deliveredLines - unique)) / deliveredLines);
    }
  }
  const fileCalls = calls.filter((at) => !at.call.attachment && at.call.spans.length > 0);
  return {
    deliveredTokens: sumOrNull(fileCalls.map((at) => at.deliveredTokens)),
    otherCalls: calls.filter((at) => at.call.spans.length === 0 && !at.call.unmapped).length,
    rereadTokens,
    unmappedCalls: calls.filter((at) => at.call.unmapped !== undefined).length,
    // The same figure the composer popover shows for this turn.
    windowTokens: fileWindowTokens(view),
  };
}

export interface ChunkCell {
  readonly chunk: IndexerFileChunkBounds;
  /** Share of the chunk's lines the drawn spans cover, 0 to 1. */
  readonly coverage: number;
  /** Every overlapping span has left the window. */
  readonly gone: boolean;
  /** The highest-priority kind drawn; null when no span reached the chunk. */
  readonly kind: ContextSpanKind | null;
  readonly partial: boolean;
  readonly spans: readonly ContextFileSpan[];
}

function overlaps(entry: ContextFileSpan, chunk: IndexerFileChunkBounds): boolean {
  const { span } = entry;
  if (span.chunkId !== undefined && span.startLine === undefined) {
    return span.chunkId === chunk.chunkId;
  }
  if (span.wholeFile) {
    return true;
  }
  return (
    span.startLine !== undefined &&
    span.endLine !== undefined &&
    span.startLine <= chunk.endLine &&
    span.endLine >= chunk.startLine
  );
}

function topKind(entries: readonly ContextFileSpan[]): ContextSpanKind | null {
  let best: ContextSpanKind | null = null;
  for (const { span } of entries) {
    if (best === null || KIND_PRIORITY[span.kind] > KIND_PRIORITY[best]) {
      best = span.kind;
    }
  }
  return best;
}

/**
 * Each index chunk with the spans that reached it. In window mode a chunk is
 * colored by its live spans, and reads as gone when only departed spans
 * reached it; in "everything" mode it takes the kind of every span.
 */
export function chunkCells(
  chunks: readonly IndexerFileChunkBounds[],
  spans: readonly ContextFileSpan[],
  mode: ContextMapMode
): ChunkCell[] {
  return chunks.map((chunk) => {
    const reached = spans.filter((entry) => overlaps(entry, chunk));
    const live = reached.filter((entry) => isLive(entry.at.state));
    const drawn = mode === 'window' && live.length > 0 ? live : reached;
    const length = chunk.endLine - chunk.startLine + 1;
    const fullChunk = drawn.some(
      (entry) =>
        entry.span.wholeFile ||
        (entry.span.chunkId === chunk.chunkId && entry.span.startLine === undefined)
    );
    const coverage = fullChunk
      ? 1
      : coveredLines(
          drawn.map((entry) => entry.span),
          chunk.startLine,
          chunk.endLine
        ).size / Math.max(length, 1);
    return {
      chunk,
      coverage,
      gone: reached.length > 0 && live.length === 0,
      kind: topKind(drawn),
      partial: drawn.some((entry) => entry.span.partial === true),
      spans: reached,
    };
  });
}

/** Equal line bands for a file the index does not cover, so its spans still draw to scale. */
export function lineBands(maxLine: number, bands = 8): IndexerFileChunkBounds[] {
  const count = Math.max(1, Math.min(bands, maxLine));
  return Array.from({ length: count }, (_, index) => {
    const startLine = Math.floor((index * maxLine) / count) + 1;
    const endLine = Math.floor(((index + 1) * maxLine) / count);
    return { chunkId: `band:${index}`, contentHash: '', endLine, startLine, tokenCount: null };
  });
}
