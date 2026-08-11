/**
 * In-memory per-thread turn state for the W7 shadow-git snapshot engine
 * (BST-1164 T2).
 *
 * WHY THIS EXISTS — the BST-1169 starvation class. The live "Last Turn"
 * refresh (`requestLiveLastTurnRefresh` → `changes:resolveView`) must never
 * queue behind a wedged database: the hot path is allowed AT MOST one
 * snapshot-repository lookup of the turn-start oid, and caching that oid in
 * memory keyed by thread + turn generation removes even that. This registry
 * IS that cache, plus the one fact no ledger row can carry: which run ids
 * belong to the CURRENTLY OPEN turn (a turn is not a run — tool-approval /
 * suspend resumes mint additional run rows through the same seam, and only
 * the first and last legs' run ids ever land on snapshot rows).
 *
 * Writers: `snapshot-turn-boundaries.ts` (the run-persistence-seam trigger).
 * Readers: `changeset-snapshot-view.ts` (live + just-settled resolution).
 * Both default to the shared process instance below so the two consumption
 * sites main.ts threads (`AssistantServerOptions.snapshots` and the changes
 * IPC options) observe one state without main.ts wiring a third seam; tests
 * construct private instances via {@link createSnapshotTurnRegistry}.
 *
 * TURN IDENTITY IS THE TRIGGERING USER MESSAGE, never a run row:
 * `anchorMessageId` records it, and a resume leg attaches to the open turn
 * (its request carries the same triggering message). Losing this state
 * (restart) is safe by construction: no live stream survives a restart, so
 * the live path is never consulted for a turn this process did not run, and
 * settled resolution reads the durable ledger instead.
 *
 * Purely in-memory and bounded to one entry per thread (the newest turn —
 * open or just-closed). Never persisted; factory reset's process restart (or
 * the next turn) naturally supersedes entries.
 */

export type SnapshotCaptureOutcome =
  | { readonly commitOid: string; readonly kind: 'captured'; readonly rootPath: string }
  | { readonly kind: 'failed'; readonly reason: string; readonly rootPath: string };

export interface SnapshotTurnState {
  /** Triggering user message id — the turn anchor. Null when the request carried no user message. */
  readonly anchorMessageId: string | null;
  /** Per-root turn-end outcomes; null while the turn is open. */
  readonly endOutcomes: ReadonlyMap<string, SnapshotCaptureOutcome> | null;
  /** The turn's FIRST leg run id (what turn-start ledger rows carry). */
  readonly firstRunId: string;
  /** Monotonic per-registry turn counter — the live-view cache key half. */
  readonly generation: number;
  /** The turn's LAST leg run id; null while the turn is open. */
  readonly lastRunId: string | null;
  readonly open: boolean;
  /** Every run id observed for this turn (first leg + every resume leg). */
  readonly runIds: ReadonlySet<string>;
  /** Per-root turn-start outcomes, keyed by rootId. */
  readonly startOutcomes: ReadonlyMap<string, SnapshotCaptureOutcome>;
  readonly threadId: string;
}

export interface BeginTurnParams {
  readonly anchorMessageId: string | null;
  /** The turn's first leg run id (the id turn-start ledger rows carry). */
  readonly runId: string;
  readonly startOutcomes: ReadonlyMap<string, SnapshotCaptureOutcome>;
}

export interface SnapshotTurnRegistry {
  /** Attach a resume leg's run id to the open turn. False when none is open. */
  attachRun(threadId: string, runId: string): boolean;
  beginTurn(threadId: string, params: BeginTurnParams): SnapshotTurnState;
  clear(): void;
  /**
   * Close the open turn with its per-root turn-end outcomes; `lastRunId` is
   * the closing leg's run id (what turn-end ledger rows carry). False when
   * no turn is open.
   */
  closeTurn(
    threadId: string,
    endOutcomes: ReadonlyMap<string, SnapshotCaptureOutcome>,
    lastRunId: string
  ): boolean;
  /** Newest turn state for the thread (open or closed), or null. */
  get(threadId: string): SnapshotTurnState | null;
  /** The open turn for the thread, or null when the newest turn is closed/absent. */
  openTurn(threadId: string): SnapshotTurnState | null;
}

interface MutableTurnState {
  anchorMessageId: string | null;
  endOutcomes: Map<string, SnapshotCaptureOutcome> | null;
  firstRunId: string;
  generation: number;
  lastRunId: string | null;
  open: boolean;
  runIds: Set<string>;
  startOutcomes: Map<string, SnapshotCaptureOutcome>;
  threadId: string;
}

function snapshotOf(state: MutableTurnState): SnapshotTurnState {
  return {
    anchorMessageId: state.anchorMessageId,
    endOutcomes: state.endOutcomes === null ? null : new Map(state.endOutcomes),
    firstRunId: state.firstRunId,
    generation: state.generation,
    lastRunId: state.lastRunId,
    open: state.open,
    runIds: new Set(state.runIds),
    startOutcomes: new Map(state.startOutcomes),
    threadId: state.threadId,
  };
}

export function createSnapshotTurnRegistry(): SnapshotTurnRegistry {
  const byThread = new Map<string, MutableTurnState>();
  let generation = 0;

  return {
    attachRun(threadId, runId) {
      const state = byThread.get(threadId);
      if (!state?.open) {
        return false;
      }
      state.runIds.add(runId);
      return true;
    },
    beginTurn(threadId, params) {
      generation += 1;
      const state: MutableTurnState = {
        anchorMessageId: params.anchorMessageId,
        endOutcomes: null,
        firstRunId: params.runId,
        generation,
        lastRunId: null,
        open: true,
        runIds: new Set([params.runId]),
        startOutcomes: new Map(params.startOutcomes),
        threadId,
      };
      byThread.set(threadId, state);
      return snapshotOf(state);
    },
    clear() {
      byThread.clear();
    },
    closeTurn(threadId, endOutcomes, lastRunId) {
      const state = byThread.get(threadId);
      if (!state?.open) {
        return false;
      }
      state.endOutcomes = new Map(endOutcomes);
      state.lastRunId = lastRunId;
      state.open = false;
      return true;
    },
    get(threadId) {
      const state = byThread.get(threadId);
      return state ? snapshotOf(state) : null;
    },
    openTurn(threadId) {
      const state = byThread.get(threadId);
      return state?.open ? snapshotOf(state) : null;
    },
  };
}

let sharedRegistry: SnapshotTurnRegistry | null = null;

/**
 * The ONE process-shared registry both main-process consumption sites default
 * to. Lazy so importing this module has no side effects beyond the closure.
 */
export function getSharedSnapshotTurnRegistry(): SnapshotTurnRegistry {
  sharedRegistry ??= createSnapshotTurnRegistry();
  return sharedRegistry;
}
