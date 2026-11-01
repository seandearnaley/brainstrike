/**
 * ADR-0034: a worktree is never indexed on its own. Retrieval for a worktree
 * folder reads the index of another open checkout of the same repository and
 * keeps a hit only while the worktree's own file still holds that chunk at the
 * same lines. Imports no Electron or database module: the host bundle loads it.
 */
import type { IndexerSearchHit } from '@brainstrike/indexing-contract/indexer-client';
import type { FileRecordRow } from './retrieval-store';

/** One open folder's git identity, or null when it is not the top of a git checkout. */
export type ResolveCheckout = (
  rootId: string
) => Promise<{ readonly commonDir: string; readonly topLevel: boolean } | null>;

/** Reads a file of an open folder as text; rejects a missing, ignored, binary or escaping path. */
export type ReadCheckoutFile = (rootId: string, relativePath: string) => Promise<string>;

export interface CheckoutReadThrough {
  readonly displayName: string;
  /** The indexed checkout whose rows answer for the worktree. */
  readonly sourceRootId: string;
  readonly worktreeRootId: string;
}

/**
 * Each unindexed folder that is the top of a checkout whose repository also has
 * an indexed checkout open, paired with that checkout. A folder that pairs with
 * none stays unindexed.
 */
export async function resolveCheckoutReadThrough(input: {
  readonly indexed: readonly string[];
  readonly resolveCheckout: ResolveCheckout;
  readonly roots: readonly { readonly displayName: string; readonly rootId: string }[];
  readonly unindexed: readonly string[];
}): Promise<readonly CheckoutReadThrough[]> {
  if (input.unindexed.length === 0) {
    return [];
  }
  const sources = (
    await Promise.all(
      input.roots
        .filter((root) => input.indexed.includes(root.rootId))
        .map(async (root) => ({ checkout: await input.resolveCheckout(root.rootId), root }))
    )
  ).filter(({ checkout }) => checkout?.topLevel === true);
  const pairs = await Promise.all(
    input.unindexed.map(async (worktreeRootId) => {
      const checkout = await input.resolveCheckout(worktreeRootId);
      const source = checkout?.topLevel
        ? sources.find((candidate) => candidate.checkout?.commonDir === checkout.commonDir)
        : undefined;
      return source
        ? [
            {
              displayName:
                input.roots.find((root) => root.rootId === worktreeRootId)?.displayName ??
                worktreeRootId,
              sourceRootId: source.root.rootId,
              worktreeRootId,
            },
          ]
        : [];
    })
  );
  return pairs.flat();
}

const LINE = /[^\n]*\n|[^\n]+$/gu;

/** The file's text over the hit's lines, the way the index splits lines. */
function linesOf(text: string, startLine: number, endLine: number): string {
  return (text.match(LINE) ?? []).slice(startLine - 1, endLine).join('');
}

/**
 * One search's reader of worktree files: each file is read once and every arm
 * of the search checks its hits against the same text. A file that cannot be
 * read (missing, ignored, binary or escaping) reads as null.
 */
export function cachedCheckoutReader(
  readFile: ReadCheckoutFile
): (rootId: string, relativePath: string) => Promise<string | null> {
  const files = new Map<string, Promise<string | null>>();
  return (rootId, relativePath) => {
    const key = JSON.stringify([rootId, relativePath]);
    let file = files.get(key);
    if (!file) {
      file = readFile(rootId, relativePath).catch(() => null);
      files.set(key, file);
    }
    return file;
  };
}

/**
 * Moves each hit of a read-through source onto its worktree when the worktree's
 * file still holds the chunk at the same lines, and drops it otherwise. The
 * source keeps none of its own hits: it is the same repository, and the thread
 * works in the worktree. Returns the chunk ids it dropped.
 */
export async function relocateCheckoutHits(
  hits: readonly IndexerSearchHit[],
  readThrough: readonly CheckoutReadThrough[],
  read: (rootId: string, relativePath: string) => Promise<string | null>
): Promise<{ readonly dropped: readonly string[]; readonly hits: readonly IndexerSearchHit[] }> {
  if (readThrough.length === 0) {
    return { dropped: [], hits };
  }
  const dropped: string[] = [];
  const kept = await Promise.all(
    hits.map(async (hit): Promise<readonly IndexerSearchHit[]> => {
      const targets = readThrough.filter((pair) => pair.sourceRootId === hit.rootId);
      if (targets.length === 0) {
        return [hit];
      }
      const moved = await Promise.all(
        targets.map(async (target) => {
          const text =
            hit.relativePath === null ? null : await read(target.worktreeRootId, hit.relativePath);
          if (text === null || !linesOf(text, hit.startLine, hit.endLine).includes(hit.content)) {
            dropped.push(hit.chunkId);
            return [];
          }
          return [{ ...hit, rootId: target.worktreeRootId }];
        })
      );
      return moved.flat();
    })
  );
  return { dropped, hits: kept.flat() };
}

/**
 * The catalog rows as the model sees them: the file of a hit moved onto a
 * worktree names the worktree, so the model reads and cites the worktree's file.
 */
export function checkoutFileRecords(
  files: ReadonlyMap<string, FileRecordRow>,
  hits: readonly Pick<IndexerSearchHit, 'fileId' | 'rootId'>[],
  readThrough: readonly CheckoutReadThrough[]
): ReadonlyMap<string, FileRecordRow> {
  if (readThrough.length === 0) {
    return files;
  }
  const moved = new Map(
    hits.flatMap((hit) => {
      const file = files.get(hit.fileId);
      const target = readThrough.find((pair) => pair.worktreeRootId === hit.rootId);
      return file && target
        ? [
            [
              hit.fileId,
              { ...file, rootId: target.worktreeRootId, rootName: target.displayName },
            ] as const,
          ]
        : [];
    })
  );
  return new Map([...files, ...moved]);
}
