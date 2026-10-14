/** Startup retention over current host-owned shadow-git chains; no legacy SQL ledger. */

import { access } from 'node:fs/promises';
import { type HostTurnSnapshot, pendingRewindSnapshotTargets } from '@brainstrike/agent-host';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { hostChainBoundary, type SnapshotChainEntry } from './snapshot-chains';
import type { ShadowRepoHandle, SnapshotService } from './snapshot-service';

/** Production probe backing {@link SnapshotStartupGcDeps.isRootPathAccessible}. */
function isPathAccessible(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

/** The plan's retention ring: newest 50 turns per thread. */
export const DEFAULT_SNAPSHOT_TURN_RING = 50;

export interface SnapshotStartupGcDeps {
  /**
   * Probe for a root path's existence before opening its shadow repo.
   * Injectable for tests; production defaults to `fs.access`.
   */
  readonly isRootPathAccessible?: (path: string) => Promise<boolean>;
  /** Connected workspace roots (every `roots` row — disconnect ≠ delete). */
  readonly liveRoots: readonly { readonly path: string; readonly rootId: string }[];
  /** The agent host's live thread ids, whose snapshot refs no ledger row backs. */
  readonly readHostThreadIds: () => Promise<ReadonlySet<string>>;
  readonly readHostThreadRows: (threadId: string) => Promise<readonly HostLogRow[]>;
  /** A thread's snapshot chain in one root, newest first (`listThreadSnapshotChain`). */
  readonly readThreadChain: (
    handle: ShadowRepoHandle,
    threadId: string
  ) => Promise<readonly SnapshotChainEntry[]>;
  readonly snapshotService: SnapshotService;
  /** Ring override for tests; production uses the default. */
  readonly turnRing?: number | undefined;
}

export interface SnapshotStartupGcReport {
  /** Thread ids whose rows + refs were purged (no thread row backs them). */
  readonly deadThreadsPruned: readonly string[];
  /** Per-item failure descriptions — the caller logs each visibly. */
  readonly failures: readonly string[];
  /** Root ids whose shadow repos were shallow-cut + gc'd this sweep. */
  readonly historyPrunedRoots: readonly string[];
  /** Host chains cut to the retention ring this sweep. */
  readonly hostRingTrimmed: readonly { readonly rootId: string; readonly threadId: string }[];
  /** Refs deleted because no ledger rows back them in that root. */
  readonly refOnlyPruned: readonly { readonly rootId: string; readonly threadId: string }[];
  /** Per-thread ring trims: how many ledger rows fell off the ring. */
  readonly ringTrimmed: readonly { readonly deletedRows: number; readonly threadId: string }[];
  /**
   * Live roots whose PATH was unreachable (deleted directory, unmounted
   * volume): their shadow repos were left untouched and the caller logs a
   * single warn — this is an expected condition, never a per-boot error.
   */
  readonly skippedInaccessibleRoots: readonly {
    readonly path: string;
    readonly rootId: string;
  }[];
}

interface GcAccumulator {
  readonly deadThreadsPruned: string[];
  readonly failures: string[];
  readonly hostRingTrimmed: { rootId: string; threadId: string }[];
  readonly refOnlyPruned: { rootId: string; threadId: string }[];
  readonly ringTrimmed: { deletedRows: number; threadId: string }[];
  readonly skippedInaccessibleRoots: { path: string; rootId: string }[];
  /** Root ids needing a pruneHistory pass. */
  readonly touchedRoots: Set<string>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The host's live thread ids, or that the host could not list them. */
type HostThreads =
  | { readonly ids: ReadonlySet<string>; readonly kind: 'listed' }
  | { readonly kind: 'unavailable' };

/**
 * The host's live thread ids, read once per sweep and only when a ref without
 * ledger rows needs the answer.
 */
function hostThreadsReader(
  deps: SnapshotStartupGcDeps,
  accumulator: GcAccumulator
): () => Promise<HostThreads> {
  let read: Promise<HostThreads> | undefined;
  return () => {
    read ??= deps.readHostThreadIds().then(
      (ids): HostThreads => ({ ids, kind: 'listed' }),
      (error: unknown): HostThreads => {
        accumulator.failures.push(
          `host thread list unavailable, so unbacked snapshot refs were kept: ${describeError(error)}`
        );
        return { kind: 'unavailable' };
      }
    );
    return read;
  };
}

/** A surviving ref no ledger row backs, and whether its chain is a live host thread's to trim. */
interface UnbackedChain {
  readonly threadId: string;
  readonly trim: boolean;
}

/**
 * Every unbacked chain's start for this root's prune: a live host thread's
 * chain keeps its newest `ring` turns (a trim marks the root for
 * reclamation), and a chain the host could not vouch for keeps its whole
 * history. Undefined when a chain cannot be read: the root is then not
 * pruned, since its shallow file must list every surviving chain's start.
 */
async function unbackedChainStarts(
  deps: SnapshotStartupGcDeps,
  accumulator: GcAccumulator,
  handle: ShadowRepoHandle,
  rootId: string,
  unbacked: readonly UnbackedChain[],
  ring: number,
  readRetentionTargets: (
    threadId: string
  ) => Promise<readonly { rootId: string; commitOid: string }[]>
): Promise<string[] | undefined> {
  const starts: string[] = [];
  for (const { threadId, trim } of unbacked) {
    let chain: readonly SnapshotChainEntry[];
    try {
      chain = await deps.readThreadChain(handle, threadId);
    } catch (error) {
      accumulator.failures.push(
        `snapshot chain unreadable for thread "${threadId}" in root "${rootId}", so the root was not pruned: ${describeError(error)}`
      );
      return;
    }
    let retainedRing = trim ? ring : Number.POSITIVE_INFINITY;
    try {
      if (trim) {
        const targets = await readRetentionTargets(threadId);
        for (const target of targets.filter((entry) => entry.rootId === rootId)) {
          const targetIndex = chain.findIndex((entry) => entry.commitOid === target.commitOid);
          if (targetIndex < 0) {
            throw new Error(
              `Pending redo target ${target.commitOid} is absent from the snapshot chain`
            );
          }
          retainedRing = Math.max(
            retainedRing,
            chain.slice(0, targetIndex + 1).filter((entry) => entry.kind === 'turn-start').length
          );
        }
      }
    } catch (error) {
      accumulator.failures.push(
        `Pending redo retention unavailable for thread "${threadId}" in root "${rootId}": ${describeError(error)}`
      );
      return;
    }
    const start = hostChainBoundary(chain, retainedRing);
    if (!start) {
      continue;
    }
    starts.push(start.boundary);
    if (start.trimmed) {
      accumulator.hostRingTrimmed.push({ rootId, threadId });
      accumulator.touchedRoots.add(rootId);
    }
  }
  return starts;
}

/**
 * Ref-side reconciliation + history reclamation for one live root's shadow
 * repo: delete lineage refs that are dead-thread or row-less residue, trim
 * live host chains to the ring, then — if this sweep touched the repo at
 * all — shallow-cut at every surviving chain's start and `git gc`.
 */
async function reconcileRootRepo(
  deps: SnapshotStartupGcDeps,
  accumulator: GcAccumulator,
  historyPrunedRoots: string[],
  root: { readonly path: string; readonly rootId: string },
  accessibleByRootId: ReadonlyMap<string, boolean>,
  readHostThreads: () => Promise<HostThreads>,
  ring: number,
  readRetentionTargets: (
    threadId: string
  ) => Promise<readonly { rootId: string; commitOid: string }[]>
): Promise<void> {
  // An unreachable root path (deleted directory, unmounted volume, a stale
  // row like the 2026-08-07 "mock-project" residue) is an EXPECTED condition:
  // skip with visibility and touch nothing — the volume may come back. Only
  // an ACCESSIBLE root whose shadow repo still fails to open is a failure.
  // Probed ONCE per sweep (up front), so both consumers see the same answer.
  if (accessibleByRootId.get(root.rootId) !== true) {
    accumulator.skippedInaccessibleRoots.push({ path: root.path, rootId: root.rootId });
    return;
  }
  let handle: ShadowRepoHandle;
  try {
    handle = await deps.snapshotService.ensureShadowRepo({
      path: root.path,
      rootId: root.rootId,
    });
  } catch (error) {
    accumulator.failures.push(
      `shadow repo unavailable for root "${root.rootId}": ${describeError(error)}`
    );
    return;
  }
  const unbacked: UnbackedChain[] = [];
  try {
    const refThreadIds = await deps.snapshotService.listSnapshotThreadIds(handle);
    for (const threadId of refThreadIds) {
      // A host thread's ref lives while the host lists the thread; unread, keep it.
      const hostThreads = await readHostThreads();
      if (hostThreads.kind === 'unavailable' || hostThreads.ids.has(threadId)) {
        unbacked.push({ threadId, trim: hostThreads.kind === 'listed' });
        continue;
      }
      await deps.snapshotService.pruneThread(handle, threadId);
      accumulator.refOnlyPruned.push({ rootId: root.rootId, threadId });
      accumulator.touchedRoots.add(root.rootId);
    }
  } catch (error) {
    // An incomplete inventory may miss a surviving chain's start: no prune.
    accumulator.failures.push(
      `ref reconciliation failed for root "${root.rootId}": ${describeError(error)}`
    );
    return;
  }
  const unbackedStarts = await unbackedChainStarts(
    deps,
    accumulator,
    handle,
    root.rootId,
    unbacked,
    ring,
    readRetentionTargets
  );
  if (!(unbackedStarts && accumulator.touchedRoots.has(root.rootId))) {
    return;
  }
  try {
    await deps.snapshotService.pruneHistory(handle, unbackedStarts);
    historyPrunedRoots.push(root.rootId);
  } catch (error) {
    accumulator.failures.push(
      `history reclamation failed for root "${root.rootId}": ${describeError(error)}`
    );
  }
}

export async function runSnapshotStartupGc(
  deps: SnapshotStartupGcDeps
): Promise<SnapshotStartupGcReport> {
  const ring = deps.turnRing ?? DEFAULT_SNAPSHOT_TURN_RING;
  const accumulator: GcAccumulator = {
    deadThreadsPruned: [],
    failures: [],
    hostRingTrimmed: [],
    refOnlyPruned: [],
    ringTrimmed: [],
    skippedInaccessibleRoots: [],
    touchedRoots: new Set(),
  };
  const historyPrunedRoots: string[] = [];

  const probe = deps.isRootPathAccessible ?? isPathAccessible;
  const accessibleByRootId = new Map<string, boolean>(
    await Promise.all(
      deps.liveRoots.map(async (root) => [root.rootId, await probe(root.path)] as const)
    )
  );

  const readHostThreads = hostThreadsReader(deps, accumulator);
  const targetsByThread = new Map<string, Promise<readonly HostTurnSnapshot[]>>();
  function readRetentionTargets(threadId: string): Promise<readonly HostTurnSnapshot[]> {
    let read = targetsByThread.get(threadId);
    if (!read) {
      read = deps.readHostThreadRows(threadId).then(pendingRewindSnapshotTargets);
      targetsByThread.set(threadId, read);
    }
    return read;
  }
  for (const root of deps.liveRoots) {
    await reconcileRootRepo(
      deps,
      accumulator,
      historyPrunedRoots,
      root,
      accessibleByRootId,
      readHostThreads,
      ring,
      readRetentionTargets
    );
  }

  return {
    deadThreadsPruned: accumulator.deadThreadsPruned,
    failures: accumulator.failures,
    historyPrunedRoots,
    hostRingTrimmed: accumulator.hostRingTrimmed,
    refOnlyPruned: accumulator.refOnlyPruned,
    ringTrimmed: accumulator.ringTrimmed,
    skippedInaccessibleRoots: accumulator.skippedInaccessibleRoots,
  };
}
