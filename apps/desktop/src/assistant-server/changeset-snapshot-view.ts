/**
 * Snapshot-sourced `ChangesetView`/`fileDiff` resolution for `agent-run` and
 * `run-range` changesets (BST-1164 W7 T2) — the successor to
 * `changeset-journal-view.ts`'s journal fold. The changeset kinds are now
 * REF-PAIR RESOLVERS over the shadow-git snapshot engine: a settled turn
 * resolves to `turn-start oid ↔ turn-end oid` per workspace root, and the
 * LIVE Last Turn (a run in flight) resolves to `turn-start oid ↔ the live
 * work-tree`. Diffs come from `SnapshotService.diffRefs` (the W1 structured
 * parsers), so shell side effects — a file created by a direct `fs` write,
 * not a tool — appear exactly like tool edits. The frozen `ChangesetView`
 * contract is unchanged except that `totalAdditions`/`totalDeletions` are now
 * REAL numbers (numstat sums, binary per-file `null`s excluded via `?? 0` —
 * the git-scope precedent), no longer the journal's `null`.
 *
 * A TURN IS NOT A RUN (the W5 lesson): resolution anchors on TURNS. The
 * in-memory {@link SnapshotTurnRegistry} maps any leg's run id to its turn
 * while this process ran it; the durable ledger's brackets
 * (`snapshot-turn-ledger.ts`) carry only the first and last legs' run ids, so
 * a HISTORICAL mid-turn resume id falls back to the run row's own
 * timestamps (`readThreadRunAnchor` + `findBracketByRunAnchor`) — the cold
 * path only.
 *
 * LIVE HOT PATH (BST-1169 starvation class — deliverable): resolving the
 * live Last Turn performs ZERO database reads. The registry's cached
 * per-root turn-start oids (keyed by thread + turn generation) stand in for
 * the one allowed snapshot-repository lookup; only shadow-git work happens
 * per refresh. The live path carries no attribution (`toolAttributed`
 * absent, never `false`).
 *
 * ATTRIBUTION: `ChangedFileEntry.toolAttributed` is VIEW-LEVEL METADATA,
 * joined by `(rootId, path|fromPath)` against the tool edits a settled host
 * run committed to its log. A legacy ledger turn has no attribution source,
 * so its files carry no `toolAttributed` either.
 *
 * HOST THREADS (BST-1977): a host turn is a run, and the host's committed
 * log records its snapshots and tool edits; `changeset-host-turns.ts`
 * resolves an `agent-run` changeset from it with these same semantics. A
 * thread the host lists is remembered, so its live refresh never reads the
 * ledger or the database; the host is asked only about a thread with no
 * ledger rows.
 *
 * NO SILENT FALLBACKS (plan global constraint 4): a missing or failed
 * capture makes the changeset VISIBLY unavailable — never "diff what we
 * can". Stable machine-readable error prefixes, registered alongside the
 * existing ones in `changeset-diff-service.ts`:
 * - `snapshot-engine-unavailable:` — the SnapshotService is not wired/ready.
 * - `changeset-snapshot-missing:` — no snapshot rows cover the turn
 *   (pre-engine turns, or a turn whose end was never recorded).
 * - `changeset-snapshot-capture-failed:` — a capture was attempted and
 *   FAILED (durable sentinel row / registry failed outcome).
 * - `run-anchor-missing:` — reused verbatim from the journal engine for the
 *   same fact (unknown run id). BST-1651 retired the sibling
 *   `runs-unavailable:` prefix along with the last probe that produced it.
 */
import type {
  ChangedFileEntry,
  Changeset,
  ChangesetView,
  GitResult,
  StructuredFileDiff,
} from '@brainstrike/types';
import type { HostThreadTurns } from './changeset-host-turns';
import {
  captureFailedError,
  type ResolvedTurnTargets,
  type RootDiffTarget,
  snapshotMissingError,
} from './changeset-snapshot-targets';
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';
import { isFailedSnapshotCaptureOid, type SnapshotRepository } from './snapshot-repository';
import type { SnapshotService } from './snapshot-service';
import {
  findBracketByRunAnchor,
  findBracketByRunId,
  resolveSnapshotTurnBrackets,
  type SnapshotTurnBracket,
} from './snapshot-turn-ledger';
import {
  getSharedSnapshotTurnRegistry,
  type SnapshotCaptureOutcome,
  type SnapshotTurnRegistry,
  type SnapshotTurnState,
} from './snapshot-turn-registry';

type SnapshotChangeset = Extract<Changeset, { kind: 'agent-run' | 'run-range' }>;
type RunRange = Pick<
  Extract<Changeset, { kind: 'run-range' }>,
  'fromRunId' | 'threadId' | 'toRunId'
>;

export interface SnapshotRunAnchor {
  readonly completedAt: string | null;
  readonly startedAt: string;
}

export interface SnapshotChangesetResolverDeps {
  readonly createRepository: (db: EditCheckpointDatabase) => SnapshotRepository;
  /** Host threads' turns, from the host's committed log (BST-1977). */
  readonly hostThreads?: HostThreadTurns | undefined;
  /** Injectable for tests; defaults to {@link readThreadRunAnchor}. */
  readonly readRunAnchor?:
    | ((
        db: EditCheckpointDatabase,
        threadId: string,
        runId: string
      ) => Promise<GitResult<SnapshotRunAnchor | null>>)
    | undefined;
  /** Defaults to the process-shared registry the turn triggers write. */
  readonly registry?: SnapshotTurnRegistry | undefined;
  readonly resolveDatabase: () => Promise<EditCheckpointDatabase>;
  /** Lazy — the service is constructed at app-ready, after IPC registration. */
  readonly resolveService: () => SnapshotService | null;
}

export interface SnapshotChangesetResolver {
  readonly fileDiff: (
    rootId: unknown,
    changeset: SnapshotChangeset,
    path: string
  ) => Promise<GitResult<StructuredFileDiff>>;
  readonly resolveView: (changeset: SnapshotChangeset) => Promise<GitResult<ChangesetView>>;
}

const RUNS_TABLE = 'brainstrike_assistant_thread_runs';

/** Bounded memo for IMMUTABLE oid↔oid per-root diffs (never worktree diffs). */
const DIFF_MEMO_MAX_ENTRIES = 16;
const MEMO_KEY_SEPARATOR = String.fromCharCode(0);

/**
 * Default runs-table anchor read (COLD PATH ONLY — never the live refresh).
 * `::text` timestamps so the microsecond fraction survives for the
 * lexicographic bracket comparison (`snapshot-turn-ledger.ts`).
 *
 * NO RELATION PROBE (BST-1651). Migration 118 owns
 * `brainstrike_assistant_thread_runs`, and `getDatabase()` cannot resolve a
 * handle before `migrate()` has run, so the `to_regclass` probe that used to
 * open this function guarded a state main cannot reach — and answered it with
 * a `runs-unavailable:` envelope claiming "no assistant run has been recorded
 * on this profile", which was false for every migrated profile. An unmigrated
 * database raises 42P01 as itself.
 */
export async function readThreadRunAnchor(
  db: EditCheckpointDatabase,
  threadId: string,
  runId: string
): Promise<GitResult<SnapshotRunAnchor | null>> {
  const result = await db.query<{ completedAt: string | null; startedAt: string }>(
    `SELECT started_at::text AS "startedAt", completed_at::text AS "completedAt"
     FROM ${RUNS_TABLE}
     WHERE id = $1 AND thread_id = $2`,
    [runId, threadId]
  );
  return { ok: true, value: result.rows[0] ?? null };
}

/** Registry outcomes → per-root FROM oids; a failed outcome fails the view. */
function fromOidsOfOutcomes(
  outcomes: ReadonlyMap<string, SnapshotCaptureOutcome>
): GitResult<Map<string, { readonly oid: string; readonly rootPath: string }>> {
  const byRoot = new Map<string, { readonly oid: string; readonly rootPath: string }>();
  for (const [rootId, outcome] of outcomes) {
    if (outcome.kind === 'failed') {
      return captureFailedError(rootId, outcome.reason);
    }
    byRoot.set(rootId, { oid: outcome.commitOid, rootPath: outcome.rootPath });
  }
  return { ok: true, value: byRoot };
}

/** Resolve a REGISTRY turn state to diff targets (live or just-settled). */
function targetsOfRegistryTurn(state: SnapshotTurnState): GitResult<ResolvedTurnTargets> {
  const fromResult = fromOidsOfOutcomes(state.startOutcomes);
  if (!fromResult.ok) {
    return fromResult;
  }
  if (state.open) {
    const targets: RootDiffTarget[] = [...fromResult.value.entries()].map(([rootId, from]) => ({
      fromOid: from.oid,
      rootId,
      rootPath: from.rootPath,
      to: { worktree: true },
    }));
    return { ok: true, value: { attribution: null, targets } };
  }
  if (state.endOutcomes === null || state.lastRunId === null) {
    return snapshotMissingError(
      `the turn for thread "${state.threadId}" closed without recorded turn-end snapshots`
    );
  }
  const targets: RootDiffTarget[] = [];
  for (const [rootId, from] of fromResult.value) {
    const end = state.endOutcomes.get(rootId);
    if (!end) {
      return snapshotMissingError(
        `root "${rootId}" has no turn-end snapshot for this turn (thread "${state.threadId}")`
      );
    }
    if (end.kind === 'failed') {
      return captureFailedError(rootId, end.reason);
    }
    targets.push({ fromOid: from.oid, rootId, rootPath: end.rootPath, to: end.commitOid });
  }
  return { ok: true, value: { attribution: null, targets } };
}

/** A ledger row's oid, with the sentinel mapped to the typed capture error. */
function oidOfRow(row: {
  readonly commitOid: string;
  readonly kind: string;
  readonly rootId: string;
}): GitResult<string> {
  if (isFailedSnapshotCaptureOid(row.commitOid)) {
    return captureFailedError(row.rootId, `the ${row.kind} capture failed when it was attempted`);
  }
  return { ok: true, value: row.commitOid };
}

/** Resolve one CLOSED ledger bracket to per-root start↔end targets. */
function targetsOfClosedBracket(
  threadId: string,
  bracket: SnapshotTurnBracket
): GitResult<ResolvedTurnTargets> {
  if (bracket.startRunId === null || bracket.endRunId === null) {
    return snapshotMissingError(
      `the snapshot ledger for thread "${threadId}" has an incomplete turn bracket ` +
        '(missing its start or end leg); this turn cannot be resolved'
    );
  }
  const rootIds = new Set([...bracket.startByRoot.keys(), ...bracket.endByRoot.keys()]);
  const targets: RootDiffTarget[] = [];
  for (const rootId of rootIds) {
    const startRow = bracket.startByRoot.get(rootId);
    const endRow = bracket.endByRoot.get(rootId);
    if (!startRow) {
      return snapshotMissingError(
        `root "${rootId}" has no turn-start snapshot row for this turn (thread "${threadId}")`
      );
    }
    if (!endRow) {
      return snapshotMissingError(
        `root "${rootId}" has no turn-end snapshot row for this turn (thread "${threadId}")`
      );
    }
    const fromResult = oidOfRow(startRow);
    if (!fromResult.ok) {
      return fromResult;
    }
    const toResult = oidOfRow(endRow);
    if (!toResult.ok) {
      return toResult;
    }
    targets.push({
      fromOid: fromResult.value,
      rootId,
      rootPath: endRow.rootPath,
      to: toResult.value,
    });
  }
  return { ok: true, value: { attribution: null, targets } };
}

/** One root's diff endpoints over a RANGE of brackets — first in-range start,
 * last in-range end (or the live work-tree for an open tail). */
function rangeTargetForRoot(
  threadId: string,
  slice: readonly SnapshotTurnBracket[],
  rootId: string,
  openTail: boolean
): GitResult<RootDiffTarget> {
  const startRow = slice
    .map((bracket) => bracket.startByRoot.get(rootId))
    .find((row) => row !== undefined);
  if (!startRow) {
    return snapshotMissingError(
      `root "${rootId}" has no turn-start snapshot row in this range (thread "${threadId}")`
    );
  }
  const fromOidResult = oidOfRow(startRow);
  if (!fromOidResult.ok) {
    return fromOidResult;
  }
  if (openTail) {
    return {
      ok: true,
      value: {
        fromOid: fromOidResult.value,
        rootId,
        rootPath: startRow.rootPath,
        to: { worktree: true },
      },
    };
  }
  const endRow = [...slice]
    .reverse()
    .map((bracket) => bracket.endByRoot.get(rootId))
    .find((row) => row !== undefined);
  if (!endRow) {
    return snapshotMissingError(
      `root "${rootId}" has no turn-end snapshot row in this range (thread "${threadId}")`
    );
  }
  const toOidResult = oidOfRow(endRow);
  if (!toOidResult.ok) {
    return toOidResult;
  }
  return {
    ok: true,
    value: {
      fromOid: fromOidResult.value,
      rootId,
      rootPath: endRow.rootPath,
      to: toOidResult.value,
    },
  };
}

/** Per-root targets for a bracket slice (union of every root the slice saw). */
function targetsOfBracketSlice(
  threadId: string,
  slice: readonly SnapshotTurnBracket[],
  openTail: boolean
): GitResult<RootDiffTarget[]> {
  const rootIds = new Set<string>();
  for (const bracket of slice) {
    for (const rootId of bracket.startByRoot.keys()) {
      rootIds.add(rootId);
    }
    for (const rootId of bracket.endByRoot.keys()) {
      rootIds.add(rootId);
    }
  }
  const targets: RootDiffTarget[] = [];
  for (const rootId of rootIds) {
    const targetResult = rangeTargetForRoot(threadId, slice, rootId, openTail);
    if (!targetResult.ok) {
      return targetResult;
    }
    targets.push(targetResult.value);
  }
  return { ok: true, value: targets };
}

/** Map one root's structured diffs to `ChangedFileEntry` rows. */
function entriesOfDiffs(
  rootId: string,
  diffs: readonly StructuredFileDiff[],
  toolAttributedFor: ((path: string) => boolean) | null
): ChangedFileEntry[] {
  return diffs.map((diff) => ({
    additions: diff.additions,
    deletions: diff.deletions,
    ...(diff.oldPath === undefined ? {} : { oldPath: diff.oldPath }),
    path: diff.path,
    repositoryRoot: null,
    // The snapshot engine can restore every captured file (T3's rewind);
    // per-entry chain bookkeeping died with the journal fold.
    revertible: true,
    rootId,
    status: diff.status,
    ...(toolAttributedFor === null ? {} : { toolAttributed: toolAttributedFor(diff.path) }),
    worktreePath: null,
  }));
}

export function createSnapshotChangesetResolver(
  deps: SnapshotChangesetResolverDeps
): SnapshotChangesetResolver {
  const registry = deps.registry ?? getSharedSnapshotTurnRegistry();
  const readRunAnchor = deps.readRunAnchor ?? readThreadRunAnchor;
  const diffMemo = new Map<string, readonly StructuredFileDiff[]>();

  function requireService(): GitResult<SnapshotService> {
    const service = deps.resolveService();
    if (!service) {
      return {
        error:
          'snapshot-engine-unavailable: the workspace snapshot service is not running. ' +
          'Restart the app; if this persists it is a wiring bug.',
        ok: false,
      };
    }
    return { ok: true, value: service };
  }

  async function repository(): Promise<SnapshotRepository> {
    return deps.createRepository(await deps.resolveDatabase());
  }

  /** diffRefs with a bounded memo for immutable oid↔oid pairs. */
  async function diffTarget(
    service: SnapshotService,
    target: RootDiffTarget
  ): Promise<readonly StructuredFileDiff[]> {
    const isImmutablePair = typeof target.to === 'string';
    const memoKey = isImmutablePair
      ? `${target.rootId}${MEMO_KEY_SEPARATOR}${target.fromOid}${MEMO_KEY_SEPARATOR}${String(target.to)}`
      : null;
    if (memoKey !== null) {
      const cached = diffMemo.get(memoKey);
      if (cached) {
        return cached;
      }
    }
    const handle = await service.ensureShadowRepo({ path: target.rootPath, rootId: target.rootId });
    const diffs = await service.diffRefs(handle, target.fromOid, target.to);
    if (memoKey !== null) {
      diffMemo.set(memoKey, diffs);
      while (diffMemo.size > DIFF_MEMO_MAX_ENTRIES) {
        const oldest = diffMemo.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        diffMemo.delete(oldest);
      }
    }
    return diffs;
  }

  /** Ledger + (cold) runs-table resolution for a run id the registry does not know. */
  async function targetsFromLedger(
    threadId: string,
    runId: string
  ): Promise<GitResult<ResolvedTurnTargets>> {
    const repo = await repository();
    const rows = await repo.snapshotsForThread(threadId);
    const brackets = resolveSnapshotTurnBrackets(rows);
    if (brackets.length === 0) {
      // A host thread records its turns in the host's log, never the ledger.
      if (deps.hostThreads && (await deps.hostThreads.owns(threadId))) {
        return await deps.hostThreads.targetsOf(threadId, runId);
      }
      return snapshotMissingError(
        `no workspace snapshots exist for thread "${threadId}" — this turn predates the snapshot engine`
      );
    }
    let bracket = findBracketByRunId(brackets, runId);
    if (!bracket) {
      // A mid-turn resume leg's id appears on no snapshot row: bracket it by
      // the run row's own timestamps. Cold path only — never the live refresh.
      const anchorResult = await readRunAnchor(await deps.resolveDatabase(), threadId, runId);
      if (!anchorResult.ok) {
        return anchorResult;
      }
      if (anchorResult.value === null) {
        return {
          error: `run-anchor-missing: runId "${runId}" was not found in thread "${threadId}".`,
          ok: false,
        };
      }
      bracket = findBracketByRunAnchor(brackets, anchorResult.value);
      if (!bracket) {
        return snapshotMissingError(
          `no snapshot turn covers run "${runId}" in thread "${threadId}" — it predates the snapshot engine`
        );
      }
    }
    if (bracket.endRunId === null) {
      // Open in the ledger. If this thread's open turn is live IN THIS
      // process, the registry path above would have matched; reaching here
      // means the turn's end was never recorded (process died mid-turn).
      return snapshotMissingError(
        `the turn covering run "${runId}" in thread "${threadId}" never recorded its turn-end snapshots`
      );
    }
    return targetsOfClosedBracket(threadId, bracket);
  }

  async function resolveAgentRunTargets(
    threadId: string,
    runId: string
  ): Promise<GitResult<ResolvedTurnTargets>> {
    const state = registry.get(threadId);
    if (state?.runIds.has(runId)) {
      return targetsOfRegistryTurn(state);
    }
    // A known host thread's turns come from the host's log alone: its live
    // refresh reads neither the ledger nor the database.
    if (deps.hostThreads?.knows(threadId)) {
      return await deps.hostThreads.targetsOf(threadId, runId);
    }
    return await targetsFromLedger(threadId, runId);
  }

  /** Bracket lookup for one RANGE anchor (by row run id, then run-row timestamps). */
  async function bracketForRangeAnchor(
    brackets: readonly SnapshotTurnBracket[],
    threadId: string,
    runId: string
  ): Promise<GitResult<SnapshotTurnBracket>> {
    const direct = findBracketByRunId(brackets, runId);
    if (direct) {
      return { ok: true, value: direct };
    }
    const registryState = registry.get(threadId);
    if (registryState?.runIds.has(runId)) {
      // The anchor belongs to the registry's newest turn; its bracket is the
      // ledger's last (open or closed) — brackets and registry share writers.
      const last = brackets.at(-1);
      if (last) {
        return { ok: true, value: last };
      }
    }
    const anchorResult = await readRunAnchor(await deps.resolveDatabase(), threadId, runId);
    if (!anchorResult.ok) {
      return anchorResult;
    }
    if (anchorResult.value === null) {
      return {
        error: `run-anchor-missing: runId "${runId}" was not found in thread "${threadId}".`,
        ok: false,
      };
    }
    const bracket = findBracketByRunAnchor(brackets, anchorResult.value);
    if (!bracket) {
      return snapshotMissingError(
        `no snapshot turn covers run "${runId}" in thread "${threadId}" — it predates the snapshot engine`
      );
    }
    return { ok: true, value: bracket };
  }

  /**
   * A host thread's range is a rewind preview's: each root's restore point
   * against the live work-tree. A range ending at a TO run is not resolved.
   */
  async function hostRangeTargets(
    hostThreads: HostThreadTurns,
    changeset: RunRange
  ): Promise<GitResult<ResolvedTurnTargets>> {
    if (changeset.toRunId !== undefined) {
      return {
        error: `run-range-unsupported: a host thread's run range resolves only to the live work-tree, so thread "${changeset.threadId}" has no range ending at run "${changeset.toRunId}".`,
        ok: false,
      };
    }
    return await hostThreads.rangeTargetsOf(changeset.threadId, changeset.fromRunId);
  }

  /**
   * Resolve a `run-range` changeset. A host thread's comes from the host's
   * log (`hostRangeTargets`); a legacy thread's from the ledger's brackets.
   */
  async function resolveRunRangeTargets(
    changeset: RunRange
  ): Promise<GitResult<ResolvedTurnTargets>> {
    // A known host thread's range comes from the host's log alone.
    if (deps.hostThreads?.knows(changeset.threadId)) {
      return await hostRangeTargets(deps.hostThreads, changeset);
    }
    const repo = await repository();
    const brackets = resolveSnapshotTurnBrackets(await repo.snapshotsForThread(changeset.threadId));
    if (brackets.length > 0) {
      return await ledgerRangeTargets(changeset, brackets);
    }
    // A host thread records its turns in the host's log, never the ledger.
    if (deps.hostThreads && (await deps.hostThreads.owns(changeset.threadId))) {
      return await hostRangeTargets(deps.hostThreads, changeset);
    }
    return snapshotMissingError(
      `no workspace snapshots exist for thread "${changeset.threadId}" — this range predates the snapshot engine`
    );
  }

  /**
   * A legacy `run-range`: the FROM turn's start ↔ the TO turn's end, per root.
   * A root mounted mid-range takes its first in-range start; a root unmounted
   * mid-range takes its last in-range end. An open TO turn resolves to the
   * live work-tree side when it is live in this process.
   */
  async function ledgerRangeTargets(
    changeset: RunRange,
    brackets: readonly SnapshotTurnBracket[]
  ): Promise<GitResult<ResolvedTurnTargets>> {
    const fromResult = await bracketForRangeAnchor(
      brackets,
      changeset.threadId,
      changeset.fromRunId
    );
    if (!fromResult.ok) {
      return fromResult;
    }
    let toBracket: SnapshotTurnBracket;
    if (changeset.toRunId === undefined) {
      const last = brackets.at(-1);
      if (!last) {
        return snapshotMissingError(`thread "${changeset.threadId}" has no snapshot turns`);
      }
      toBracket = last;
    } else {
      const toResult = await bracketForRangeAnchor(brackets, changeset.threadId, changeset.toRunId);
      if (!toResult.ok) {
        return toResult;
      }
      toBracket = toResult.value;
    }
    const fromIndex = brackets.indexOf(fromResult.value);
    const toIndex = brackets.indexOf(toBracket);
    if (toIndex < fromIndex) {
      // Inverted range: honest empty view (journal-engine precedent).
      return { ok: true, value: { attribution: null, targets: [] } };
    }
    const slice = brackets.slice(fromIndex, toIndex + 1);
    const openTail = toBracket.endRunId === null;
    if (openTail && registry.openTurn(changeset.threadId) === null) {
      return snapshotMissingError(
        `the newest turn in thread "${changeset.threadId}" never recorded its turn-end snapshots`
      );
    }

    const targetsResult = targetsOfBracketSlice(changeset.threadId, slice, openTail);
    if (!targetsResult.ok) {
      return targetsResult;
    }
    return { ok: true, value: { attribution: null, targets: targetsResult.value } };
  }

  async function resolveTargets(
    changeset: SnapshotChangeset
  ): Promise<GitResult<ResolvedTurnTargets>> {
    if (changeset.kind === 'agent-run') {
      return await resolveAgentRunTargets(changeset.threadId, changeset.runId);
    }
    return await resolveRunRangeTargets(changeset);
  }

  async function resolveView(changeset: SnapshotChangeset): Promise<GitResult<ChangesetView>> {
    const serviceResult = requireService();
    if (!serviceResult.ok) {
      return serviceResult;
    }
    const targetsResult = await resolveTargets(changeset);
    if (!targetsResult.ok) {
      return targetsResult;
    }
    const { attribution: records, targets } = targetsResult.value;

    const files: ChangedFileEntry[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const target of targets) {
      const diffs = await diffTarget(serviceResult.value, target);
      for (const diff of diffs) {
        totalAdditions += diff.additions ?? 0;
        totalDeletions += diff.deletions ?? 0;
      }
      const scopedAttribution =
        records === null
          ? null
          : (path: string) =>
              records.some(
                (record) =>
                  record.rootId === target.rootId &&
                  (record.path === path || record.fromPath === path)
              );
      files.push(...entriesOfDiffs(target.rootId, diffs, scopedAttribution));
    }
    return { ok: true, value: { changeset, files, totalAdditions, totalDeletions } };
  }

  async function fileDiff(
    rootId: unknown,
    changeset: SnapshotChangeset,
    path: string
  ): Promise<GitResult<StructuredFileDiff>> {
    if (typeof rootId !== 'string' || rootId.trim().length === 0) {
      return { error: 'snapshot fileDiff requires a non-empty rootId string.', ok: false };
    }
    const serviceResult = requireService();
    if (!serviceResult.ok) {
      return serviceResult;
    }
    const targetsResult = await resolveTargets(changeset);
    if (!targetsResult.ok) {
      return targetsResult;
    }
    const target = targetsResult.value.targets.find(
      (candidate) => candidate.rootId === rootId.trim()
    );
    if (!target) {
      return {
        error: `no snapshot-captured root "${rootId.trim()}" in this changeset`,
        ok: false,
      };
    }
    const diffs = await diffTarget(serviceResult.value, target);
    const diff = diffs.find((candidate) => candidate.path === path);
    if (!diff) {
      return {
        error: `no snapshot-captured change for path "${path}" in root "${rootId.trim()}" for this changeset`,
        ok: false,
      };
    }
    return { ok: true, value: diff };
  }

  return { fileDiff, resolveView };
}
