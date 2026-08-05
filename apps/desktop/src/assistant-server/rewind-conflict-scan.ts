/**
 * Pre-flight conflict scan for a rewind's range revert (BST-1115, W5 T3).
 *
 * THE WHOLE POINT: a rewind deletes user file changes. The acknowledgment gate
 * (`applyRewind`) is only as good as the list it gates on, so this module has
 * to answer "would ANY part of this revert refuse?" WITHOUT touching disk. It
 * does that by replaying the revert against an in-memory overlay of file
 * states, using the SAME dispatch and the SAME predicates the executor
 * (`edit-checkpoint-revert.ts`) uses. Any divergence between the two would let
 * a scan report "clean" for a revert that then fails halfway — exactly the
 * partially-applied state the gate exists to prevent.
 *
 * WHY AN OVERLAY AND NOT A PER-FILE DISK COMPARE: a file edited in TWO runs of
 * the range has two journal entries. Only the NEWEST one's after-state matches
 * what is on disk right now; the older one's after-state only becomes true
 * once the newer entry has been reverted. Comparing every entry against
 * current disk would report a false conflict for every multi-run file. The
 * overlay carries the simulated result of each revert forward, so the chain is
 * validated end to end — including the genuinely broken case where an
 * un-journaled hand edit landed BETWEEN two runs, which a per-file compare
 * would miss entirely and which would otherwise blow up mid-apply.
 *
 * Records already marked `reverted_at` are excluded from the plan (the
 * executor would no-op them) and therefore from the simulation — their effect
 * is already on disk.
 */

import type { AssistantEditCheckpointRecord } from '@brainstrike/agent';
import { isRevertibleCaptureStatus } from '@brainstrike/agent';
import type { AssistantRewindConflict } from '@brainstrike/assistant-contract';
import { resolveWorkspaceWritePath } from '../secure-file-write';
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';
import { readDiskState } from './edit-checkpoint-revert';
import { loadWorkspaceRootsFromDatabase } from './workspace-roots';

const CHECKPOINTS_TABLE = 'brainstrike_assistant_edit_checkpoints';

/** NUL separator — see `changeset-journal-view.ts`'s `foldKey` for why a
 * printable delimiter cannot disambiguate `(rootId, path)` pairs. Written via
 * `fromCharCode` so this source file never contains a raw NUL byte. */
const OVERLAY_KEY_SEPARATOR = String.fromCharCode(0);

function overlayKey(rootId: string, workspacePath: string): string {
  return `${rootId}${OVERLAY_KEY_SEPARATOR}${workspacePath}`;
}

interface SimulatedFileState {
  readonly existed: boolean;
  readonly hash: string | null;
}

export interface RewindRootInfo {
  readonly label: string | null;
  /** `null` ⇒ the root is no longer connected, so nothing in it can revert. */
  readonly path: string | null;
}

export interface RewindRevertPlan {
  readonly conflicts: readonly AssistantRewindConflict[];
  /**
   * The exact ordered work list `applyRewind` executes — NEWEST FIRST across
   * every run in the range. Sharing one ordered list between scan and apply is
   * what makes the scan's verdict binding: they cannot disagree about order.
   */
  readonly records: readonly AssistantEditCheckpointRecord[];
  readonly roots: ReadonlyMap<string, RewindRootInfo>;
}

/**
 * Reverse apply order across the WHOLE range: `(occurred_at, id)` descending,
 * resolved in SQL rather than by sorting the already-loaded records in JS.
 *
 * `AssistantEditCheckpointRecord.occurredAt` (`edit-checkpoint-journal.ts`'s
 * `mapCheckpointRecordRow` → `toIso`) is `new Date(value).toISOString()`,
 * which is millisecond-resolution; `occurred_at` itself stores microseconds.
 * Two checkpoints for the same file inside one millisecond therefore compare
 * EQUAL on that field, and a JS-side tiebreak on `id` (`crypto.randomUUID()`,
 * a v4 UUID with no relationship to time) would decide the order with a coin
 * flip. Reverted out of order, the older record's `afterHash` would not match
 * disk, both records would land in `conflicts`, and forcing them would leave
 * the file holding the wrong record's before-content while reporting
 * `reverted` — a wrong restore reported as a correct one. Ordering in SQL
 * against the full microsecond value avoids the truncation entirely, the same
 * way `revertCheckpointRun:549` (`edit-checkpoint-revert.ts`) already does;
 * this does not re-derive `occurredAt` as `::text` and thread a second
 * timestamp field through `AssistantEditCheckpointRecord` everywhere it flows.
 *
 * This is the single definition of revert order. Do not sort again at the call
 * site, and never hand this list to `Promise.all`: for a file touched by more
 * than one run, order IS correctness, not a performance preference.
 */
export async function orderRewindRecordsNewestFirst(
  db: EditCheckpointDatabase,
  records: readonly AssistantEditCheckpointRecord[]
): Promise<readonly AssistantEditCheckpointRecord[]> {
  if (records.length === 0) {
    return [];
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  const result = await db.query<{ id: string }>(
    `SELECT id AS "id" FROM ${CHECKPOINTS_TABLE}
     WHERE id = ANY($1)
     ORDER BY occurred_at DESC, id DESC`,
    [records.map((record) => record.id)]
  );
  return result.rows.map((row) => {
    const record = byId.get(row.id);
    if (!record) {
      throw new Error(`rewind order resolution lost record "${row.id}" between load and sort.`);
    }
    return record;
  });
}

function conflict(
  record: AssistantEditCheckpointRecord,
  root: RewindRootInfo | undefined,
  code: AssistantRewindConflict['code'],
  message: string,
  workspacePath = record.path
): AssistantRewindConflict {
  return {
    checkpointId: record.id,
    code,
    message,
    path: workspacePath,
    rootId: record.rootId,
    rootLabel: root?.label ?? null,
  };
}

/** Lazily-materialized view of the filesystem, seeded from real disk reads and
 * then advanced by each simulated revert. */
class FileStateOverlay {
  private readonly states = new Map<string, SimulatedFileState>();

  constructor(private readonly roots: ReadonlyMap<string, RewindRootInfo>) {}

  async read(rootId: string, workspacePath: string): Promise<SimulatedFileState> {
    const key = overlayKey(rootId, workspacePath);
    const cached = this.states.get(key);
    if (cached) {
      return cached;
    }
    const rootPath = this.roots.get(rootId)?.path;
    if (!rootPath) {
      // Callers must check root availability BEFORE reading; reaching here
      // would mean a disconnected root was simulated as if it were mounted.
      throw new Error(`rewind scan read a path in unavailable root "${rootId}".`);
    }
    const resolved = await resolveWorkspaceWritePath(rootPath, workspacePath);
    const state = await readDiskState(resolved.absolutePath);
    this.states.set(key, state);
    return state;
  }

  write(rootId: string, workspacePath: string, state: SimulatedFileState): void {
    this.states.set(overlayKey(rootId, workspacePath), state);
  }
}

/**
 * One record's simulated revert. Mirrors `revertCheckpointEntry`'s dispatch
 * branch for branch; each branch's predicate is the same condition
 * `assertNoConflict` is given there. Returns the conflict it would raise, or
 * `null` after advancing the overlay.
 */
async function simulateRecord(
  overlay: FileStateOverlay,
  record: AssistantEditCheckpointRecord,
  root: RewindRootInfo
): Promise<AssistantRewindConflict | null> {
  if (!isRevertibleCaptureStatus(record.captureStatus)) {
    return conflict(
      record,
      root,
      'capture-unavailable',
      `"${record.path}" cannot be restored: capture status "${record.captureStatus}" has no stored before-state.`
    );
  }

  if (record.op === 'rename') {
    if (record.fromPath === null) {
      return conflict(
        record,
        root,
        'capture-unavailable',
        `"${record.path}" cannot be restored: the rename source path was not recorded.`
      );
    }
    const origin = await overlay.read(record.rootId, record.path);
    const target = await overlay.read(record.rootId, record.fromPath);
    if (!origin.existed || target.existed) {
      return conflict(
        record,
        root,
        'path-occupied',
        `"${record.path}" cannot be renamed back to "${record.fromPath}": the renamed file or its original path changed since the checkpoint.`
      );
    }
    overlay.write(record.rootId, record.path, { existed: false, hash: null });
    overlay.write(record.rootId, record.fromPath, origin);
    return null;
  }

  if (record.op === 'write' && record.captureStatus === 'created') {
    const current = await overlay.read(record.rootId, record.path);
    if (!(current.existed && current.hash === record.afterHash)) {
      return conflict(
        record,
        root,
        'disk-changed',
        `"${record.path}" cannot be removed: the created file changed since the checkpoint was recorded.`
      );
    }
    overlay.write(record.rootId, record.path, { existed: false, hash: null });
    return null;
  }

  if (record.op === 'delete') {
    if (record.captureStatus !== 'ok') {
      return conflict(
        record,
        root,
        'capture-unavailable',
        `"${record.path}" cannot be recreated: its before-content is not stored.`
      );
    }
    const current = await overlay.read(record.rootId, record.path);
    if (current.existed) {
      return conflict(
        record,
        root,
        'path-occupied',
        `"${record.path}" cannot be recreated: a file now exists at the deleted path.`
      );
    }
    overlay.write(record.rootId, record.path, { existed: true, hash: record.beforeHash });
    return null;
  }

  // Restore-write. `created`/`rename` capture statuses reach this branch only
  // for a non-`write` op (e.g. a `string_replace` recorded as `created`), and
  // neither stores before-content, so the executor would refuse.
  if (record.captureStatus !== 'ok') {
    return conflict(
      record,
      root,
      'capture-unavailable',
      `"${record.path}" cannot be restored: capture status "${record.captureStatus}" stored no before-content for a "${record.op}" edit.`
    );
  }
  const current = await overlay.read(record.rootId, record.path);
  if (!(current.existed === record.afterExisted && current.hash === record.afterHash)) {
    return conflict(
      record,
      root,
      'disk-changed',
      `"${record.path}" cannot be restored: the file changed since the checkpoint was recorded.`
    );
  }
  overlay.write(record.rootId, record.path, { existed: true, hash: record.beforeHash });
  return null;
}

/**
 * Build the revert plan for a range and list EVERY reason it would not apply
 * cleanly.
 *
 * A conflicting record does NOT stop the scan: the whole point is to hand the
 * user the complete list of blocked paths in one pass. A conflicted record
 * leaves the overlay untouched (the executor would have left disk untouched
 * too), so later records in the same chain are evaluated against the state
 * that would really be there.
 *
 * Roots are resolved once, and EVERY root the range touches appears in
 * `roots` — including one that is no longer connected, which yields a
 * `root-unavailable` conflict per record rather than a silent skip.
 */
export async function scanRewindRange(
  db: EditCheckpointDatabase,
  records: readonly AssistantEditCheckpointRecord[]
): Promise<RewindRevertPlan> {
  const plan = await orderRewindRecordsNewestFirst(
    db,
    records.filter((record) => record.revertedAt === null)
  );
  const connected = await loadWorkspaceRootsFromDatabase(db);
  const connectedById = new Map(connected.map((root) => [root.rootId, root]));
  const roots = new Map<string, RewindRootInfo>();
  for (const record of plan) {
    if (!roots.has(record.rootId)) {
      const live = connectedById.get(record.rootId);
      roots.set(record.rootId, {
        label: live?.displayName ?? null,
        path: live?.path ?? null,
      });
    }
  }

  const overlay = new FileStateOverlay(roots);
  const conflicts: AssistantRewindConflict[] = [];
  for (const record of plan) {
    const root = roots.get(record.rootId);
    if (!root || root.path === null) {
      conflicts.push(
        conflict(
          record,
          root,
          'root-unavailable',
          `"${record.path}" cannot be restored: its workspace folder is no longer connected. Re-open the folder and try again.`
        )
      );
      continue;
    }
    const found = await simulateRecord(overlay, record, root);
    if (found) {
      conflicts.push(found);
    }
  }
  return { conflicts, records: plan, roots };
}
