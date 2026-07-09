import type { TreeNode } from '@brainstrike/ui';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import type { SelectedChunk } from '../bridge/chunk-selection-store';
import type {
  WorkspaceSearchChild,
  WorkspaceSearchChunkHit,
  WorkspaceSearchFileResult,
  WorkspaceSearchResults,
  WorkspaceSearchTextMatch,
} from '../core/search-result-model';

/**
 * Row payload for the workspace-search results tree. `compositeKey` is the
 * file-selection key (root-scoped) used by the selection bridge; it is only
 * ever null for defensive typing — files whose root is unmounted are omitted
 * entirely rather than rendered non-actionable, so emitted rows always carry a
 * real key.
 *
 * Tree shape:
 * - Text mode: file → chunk → match. The CHUNK is the single visible selection
 *   unit (checkbox); match rows are navigation-only leaves.
 * - Semantic mode: file → chunk (unchanged; chunk carries the checkbox).
 */
export type SearchNodeData =
  | { kind: 'file'; file: WorkspaceSearchFileResult; compositeKey: string | null }
  | {
      chunk: WorkspaceSearchChunkHit;
      compositeKey: string | null;
      filePath: string;
      kind: 'chunk';
    }
  | {
      chunkEndLine: number;
      chunkId: string;
      chunkStartLine: number;
      compositeKey: string | null;
      filePath: string;
      kind: 'text-chunk';
      matchCount: number;
    }
  | {
      compositeKey: string | null;
      filePath: string;
      kind: 'match';
      match: WorkspaceSearchTextMatch;
    };

/** Stable file row id (matches the store's expandedIds convention). */
export function fileNodeId(file: Pick<WorkspaceSearchFileResult, 'dbRootId' | 'path'>): string {
  return `f:${file.dbRootId}:${file.path}`;
}

/**
 * Stable child row id: `m:${chunkId}:${line}` for a text match (line
 * disambiguates multiple matches inside one chunk) or `m:${chunkId}` for a
 * whole-chunk semantic hit.
 */
export function childNodeId(child: WorkspaceSearchChild): string {
  return child.kind === 'match' ? `m:${child.chunkId}:${child.line}` : `m:${child.chunkId}`;
}

/** Stable text-mode chunk-group row id (matches the store's default expansion). */
export function textChunkNodeId(chunkId: string): string {
  return `c:${chunkId}`;
}

interface TextChunkGroup {
  chunkEndLine: number;
  chunkId: string;
  chunkStartLine: number;
  matches: WorkspaceSearchTextMatch[];
}

type OrderedChild =
  | { chunk: WorkspaceSearchChunkHit; type: 'chunk' }
  | { group: TextChunkGroup; type: 'text-chunk' };

/**
 * Splits a file's children into ordered tree children. Semantic chunk hits pass
 * through 1:1; text matches are grouped by `chunkId` (first-seen chunk order,
 * match order preserved within a chunk) so several matches sharing a chunk
 * collapse to a single selectable chunk row.
 */
function groupFileChildren(children: readonly WorkspaceSearchChild[]): OrderedChild[] {
  const ordered: OrderedChild[] = [];
  const groupByChunkId = new Map<string, TextChunkGroup>();

  for (const child of children) {
    if (child.kind === 'chunk') {
      ordered.push({ chunk: child, type: 'chunk' });
      continue;
    }
    let group = groupByChunkId.get(child.chunkId);
    if (group === undefined) {
      group = {
        chunkEndLine: child.chunkEndLine,
        chunkId: child.chunkId,
        chunkStartLine: child.chunkStartLine,
        matches: [],
      };
      groupByChunkId.set(child.chunkId, group);
      ordered.push({ group, type: 'text-chunk' });
    }
    group.matches.push(child);
  }

  return ordered;
}

/**
 * Flattens results into the PRE-FLATTENED visible row model TreeTable consumes
 * (`nodesArePreFlattened`). Respects `expandedIds` at both levels: a collapsed
 * file emits only its own row; an expanded text file emits its chunk-group rows,
 * and each chunk emits its match rows only when the chunk id is expanded.
 * Files whose `resolveAdapterRootId(dbRootId)` returns null (root not mounted)
 * are omitted along with all their children.
 */
export function buildSearchTreeNodes(args: {
  results: WorkspaceSearchResults;
  expandedIds: ReadonlySet<string>;
  resolveAdapterRootId: (dbRootId: string) => string | null;
}): TreeNode<SearchNodeData>[] {
  const { results, expandedIds, resolveAdapterRootId } = args;
  const rows: TreeNode<SearchNodeData>[] = [];

  for (const file of results.files) {
    const adapterRootId = resolveAdapterRootId(file.dbRootId);
    if (adapterRootId === null) {
      continue;
    }
    const compositeKey = encodeFileSelection(adapterRootId, file.path);
    const id = fileNodeId(file);
    const orderedChildren = groupFileChildren(file.children);

    rows.push({
      childCount: orderedChildren.length,
      data: { compositeKey, file, kind: 'file' },
      depth: 0,
      hasChildren: orderedChildren.length > 0,
      id,
      parentId: null,
      type: 'file',
    });

    if (!expandedIds.has(id)) {
      continue;
    }

    for (const entry of orderedChildren) {
      if (entry.type === 'chunk') {
        rows.push({
          data: { chunk: entry.chunk, compositeKey, filePath: file.path, kind: 'chunk' },
          depth: 1,
          hasChildren: false,
          id: childNodeId(entry.chunk),
          parentId: id,
          type: 'chunk',
        });
        continue;
      }

      const { group } = entry;
      const chunkNodeId = textChunkNodeId(group.chunkId);
      rows.push({
        childCount: group.matches.length,
        data: {
          chunkEndLine: group.chunkEndLine,
          chunkId: group.chunkId,
          chunkStartLine: group.chunkStartLine,
          compositeKey,
          filePath: file.path,
          kind: 'text-chunk',
          matchCount: group.matches.length,
        },
        depth: 1,
        hasChildren: group.matches.length > 0,
        id: chunkNodeId,
        parentId: id,
        type: 'chunk',
      });

      if (!expandedIds.has(chunkNodeId)) {
        continue;
      }

      for (const match of group.matches) {
        rows.push({
          data: { compositeKey, filePath: file.path, kind: 'match', match },
          depth: 2,
          hasChildren: false,
          id: childNodeId(match),
          parentId: chunkNodeId,
          type: 'match',
        });
      }
    }
  }

  return rows;
}

/**
 * The file's full result-chunk list as `SelectedChunk`s (semantic chunk hits and
 * grouped text-mode chunks alike), independent of tree expansion. The selection
 * bridge needs this to CONVERT a whole-file selection into "everything except the
 * unchecked chunk" — so it must be the authoritative list, not just visible rows.
 */
export function fileResultChunks(file: WorkspaceSearchFileResult): SelectedChunk[] {
  return groupFileChildren(file.children).map((entry) =>
    entry.type === 'chunk'
      ? {
          chunkId: entry.chunk.chunkId,
          endLine: entry.chunk.endLine,
          startLine: entry.chunk.startLine,
        }
      : {
          chunkId: entry.group.chunkId,
          endLine: entry.group.chunkEndLine,
          startLine: entry.group.chunkStartLine,
        }
  );
}
