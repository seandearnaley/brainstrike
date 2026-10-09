/**
 * A thread's snapshot chain in one root's shadow repo, read from shadow git
 * alone (BST-1977). Each snapshot commit records `{kind, runId, threadId}`
 * and parents on the thread's previous snapshot in that root, so the chain is
 * that root's turns in order. Host threads record their turns in the host's
 * log, never the ledger; the startup GC trims their chains from this listing
 * (`hostChainBoundary`) instead of reading that log.
 *
 * A read-only walk of the thread's ref, so it takes no root mutex. Malformed
 * or foreign metadata refuses rather than being skipped: a retention cut is
 * computed from this listing, and a guess there would reclaim live history.
 */
import {
  assertValidOid,
  createShadowGitPlumbing,
  type SnapshotGitCommandRunner,
  SnapshotGitError,
  snapshotRefForThread,
} from './snapshot-git';
import type { ShadowRepoHandle, SnapshotKind } from './snapshot-service';

const SNAPSHOT_KINDS: ReadonlySet<string> = new Set(['pre-revert', 'turn-end', 'turn-start']);

/** One snapshot commit of a thread's chain. */
export interface SnapshotChainEntry {
  readonly commitOid: string;
  readonly kind: SnapshotKind;
  readonly runId?: string;
}

function chainEntry(line: string, threadId: string): SnapshotChainEntry {
  const separator = line.indexOf('\0');
  const commitOid = line.slice(0, separator);
  let metadata: unknown;
  try {
    metadata = separator < 0 ? undefined : JSON.parse(line.slice(separator + 1));
  } catch {
    metadata = undefined;
  }
  if (
    !(
      metadata &&
      typeof metadata === 'object' &&
      'kind' in metadata &&
      typeof metadata.kind === 'string' &&
      SNAPSHOT_KINDS.has(metadata.kind) &&
      'threadId' in metadata &&
      metadata.threadId === threadId
    ) ||
    ('runId' in metadata && typeof metadata.runId !== 'string')
  ) {
    throw new SnapshotGitError(
      'git-command-failed',
      `Snapshot commit ${commitOid || '(unknown)'} does not belong to thread "${threadId}"`
    );
  }
  assertValidOid(commitOid, 'snapshot chain commit');
  return {
    commitOid,
    kind: metadata.kind as SnapshotKind,
    ...('runId' in metadata && typeof metadata.runId === 'string' ? { runId: metadata.runId } : {}),
  };
}

/**
 * The thread's chain in this root, newest first, as far back as the shallow
 * cut keeps it. A thread with no snapshots in this root has an empty chain.
 */
export async function listThreadSnapshotChain(
  runner: SnapshotGitCommandRunner,
  handle: ShadowRepoHandle,
  threadId: string
): Promise<readonly SnapshotChainEntry[]> {
  const plumbing = createShadowGitPlumbing({
    gitDir: handle.gitDir,
    rootPath: handle.rootPath,
    runner,
  });
  const head = await plumbing.resolveRefOrNull(snapshotRefForThread(threadId));
  if (head === null) {
    return [];
  }
  const log = await plumbing.runOrThrow(['log', '--format=%H%x00%s', head]);
  return log.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => chainEntry(line, threadId));
}

/**
 * Where a host chain's history starts after this sweep: the `ring`-th newest
 * turn start when the chain holds more turns than the ring (a trim), else its
 * current base. A prune rewrites the root's whole shallow file, so it lists
 * every surviving chain's start, a chain an earlier sweep cut included.
 * Undefined for an empty chain.
 */
export function hostChainBoundary(
  chain: readonly SnapshotChainEntry[],
  ring: number
): { readonly boundary: string; readonly trimmed: boolean } | undefined {
  const turnStarts = chain.filter((entry) => entry.kind === 'turn-start');
  const cut = turnStarts.length > ring ? turnStarts[ring - 1] : undefined;
  if (cut) {
    return { boundary: cut.commitOid, trimmed: true };
  }
  const base = chain.at(-1);
  return base ? { boundary: base.commitOid, trimmed: false } : undefined;
}
