/**
 * Journal-sourced `ChangesetView`/`fileDiff` resolution for `agent-run` and
 * `run-range` changesets (BST-1113) — split out of `changeset-diff-service.ts`
 * to keep that file under its line-count budget. See that module's doc
 * comment for the overall dispatch.
 *
 * READ-ONLY: this module never writes a journal row, never creates
 * `brainstrike_assistant_thread_runs`, and never produces a `runId` — the
 * runId provenance invariant (`docs/agents/assistant-persistence.md`,
 * settled) forbids a second producer.
 *
 * FOLD KEYING RULE (renames): records are folded into ONE `ChangedFileEntry`
 * per LOGICAL file, keyed by its CURRENT (most-recent) path — NOT by the raw
 * `path` column of each row, because a `rename` record's identity spans two
 * path strings (`fromPath` → `path`). Processing records in
 * `occurred_at, id` order:
 * - write/string_replace key on `record.path` directly.
 * - rename keys on `record.fromPath` (its PRIOR identity) to find any
 *   existing accumulator entry, then re-keys it under `record.path` (its NEW
 *   identity) and deletes the old key.
 * - delete keys on `record.path` to find the entry, but then WRITES BACK
 *   under that entry's ORIGINAL pre-range identity when one is known (see
 *   DELETE OF A RENAMED PATH below) — never under `record.path` itself in
 *   that case.
 *
 * ADDED PERSISTS ACROSS LATER TOUCHES (`createdInRange`): each accumulator
 * entry carries a `createdInRange: boolean`, set ONCE from the very FIRST
 * record ever seen for that logical file (`beforeExisted: false` on a
 * write/string_replace with no prior accumulator entry ⇒ `true`; a rename of
 * a path with NO prior accumulator entry ⇒ `false`, since the journal has no
 * record of that file being created in-range, so it must have pre-existed).
 * Every SUBSEQUENT record inherits the accumulator's existing
 * `createdInRange` UNCHANGED — a second write, or a rename hop, never
 * "downgrades" `added` to `modified`/`renamed`. This matches git's own
 * semantics for a path whose old side is absent (`added`) regardless of how
 * many times it is subsequently written within the diff's scope. Concretely:
 * write(created A) → write(A) ⇒ `added` (not `modified` — the first write's
 * `beforeExisted: false` is authoritative). write(created A) → rename A→B →
 * write(B) ⇒ `added` at `B`, `oldPath: null` (B has no external "before"
 * identity — it never existed outside this changeset, under ANY name).
 *
 * A file that pre-existed the range (or was already a `renamed` entry from
 * an earlier hop) folds a further rename to `status: 'renamed'` with
 * `oldPath` CHAIN-COMPRESSED to the ORIGINAL pre-range path (so A→B→C in one
 * changeset reports `oldPath: 'A'`, not the intermediate `'B'`). That
 * pre-range identity can come from EITHER contributor a rename touches — the
 * renamed-FROM chain (`prior`, keyed at `fromPath`) or an ABSORBED occupant
 * already sitting at the destination (see RENAME/DELETE-REKEY DESTINATION
 * COLLISION below and `mergePreRangeIdentity`) — whichever one actually
 * pre-existed the range; when BOTH did, `prior` wins (R7b, review finding:
 * the pre-R7b code derived this identity from `prior` alone, so an absorbed
 * occupant's genuine pre-range identity was silently discarded whenever
 * `prior` itself was `createdInRange`). If the merged entry's surviving
 * pre-range identity equals the rename's OWN destination path (the occupant
 * or `prior` pre-existed under that exact name), the entry reports
 * `status: 'modified'` with no `oldPath` — there was no NET rename relative
 * to whichever identity survived, only a same-named replacement.
 *
 * `oldPath` is reported ONLY when the final status is `'renamed'` — a
 * `deleted`/`modified`/`added` entry never carries a stale rename breadcrumb.
 *
 * DELETE OF A RENAMED PATH: `record.path` for a delete that follows a rename
 * is a path that NEVER existed outside this changeset — only its
 * PREDECESSOR did. So when the accumulator entry being deleted carries a
 * non-null `oldPath` (it descends from a rename), the resulting `'deleted'`
 * entry is re-keyed and reported under that ORIGINAL pre-range path, not
 * `record.path` — mirroring what a plain `git mv a b && rm b` would show
 * against pre-range state (`a` deleted; `b` never appears at all). A delete
 * with no rename in its history is unaffected (keyed at `record.path`, same
 * as before).
 *
 * RENAME/DELETE-REKEY DESTINATION COLLISION: if the identity a rename or a
 * delete-rekey is about to occupy ALREADY has a live accumulator entry, two
 * outcomes are possible, both handled explicitly (see
 * `absorbFinishedOccupant`) — never a silent overwrite that discards a
 * chain and corrupts `revertible` (a conjunction over the WHOLE chain):
 * - The occupant's status is `'deleted'` (its history is FINISHED — this is
 *   the ordinary "delete the old file, then move a new one into its place"
 *   shape): its `chainRecords` are ABSORBED as a chronological prefix onto
 *   the surviving entry — a well-defined merge, not a guess, that can only
 *   make `revertible` more conservative.
 * - Any other occupant status is a genuinely ambiguous collision (two live,
 *   unfinished histories can't coexist at one path): this throws a
 *   `journal-path-collision:`-prefixed error (surfaced by the caller as a
 *   typed `GitResult` failure via the try/catch in
 *   `changeset-diff-service.ts`) rather than guessing how to merge them.
 *
 * ABSORPTION TRADE-OFF (NTH-2, review finding): absorbing a finished
 * occupant folds its `chainRecords` into the surviving entry's `revertible`
 * computation, but the occupant's OWN pre-range path never gets its own row
 * in the `ChangesetView` listing — e.g. `delete b ; rename a→b ; delete b`
 * yields ONE listed entry (`deleted` at `a`), even though the original `b`
 * also pre-existed and is also gone. Its records are still counted (so
 * `revertible` stays honest), but the LISTING loses that path. Accepted as
 * the cost of not denying the whole view over an ordinary "replace this
 * file" sequence — a per-path UI (rather than a per-changeset one) is a W4
 * concern if this ever needs to surface both identities separately.
 */
import { lstat, open, readlink } from 'node:fs/promises';
import path from 'node:path';
import type { AssistantEditCheckpointRecord } from '@brainstrike/agent';
import { isRevertibleCaptureStatus } from '@brainstrike/agent';
import type {
  ChangedFileEntry,
  ChangedFileStatus,
  Changeset,
  ChangesetView,
  GitResult,
  StructuredFileDiff,
} from '@brainstrike/types';
import type { RootCwdResult } from '../workspace-root-cwd';
import {
  type EditCheckpointDatabase,
  listRunCheckpoints,
  listRunRangeCheckpoints,
  readCheckpointBeforeContent,
} from './edit-checkpoint-journal';
import {
  assertUntrackedDiffPathContained,
  STRUCTURED_DIFF_CONTENT_CAP_BYTES,
  toErrorMessage,
} from './git-service';

type JournalChangeset = Extract<Changeset, { kind: 'agent-run' | 'run-range' }>;

/** Internal fold accumulator — richer than the public {@link ChangedFileEntry}:
 * keeps every contributing record (across renames) so `fileDiff` can locate
 * the first unreverted record's content and `revertible` can inspect the
 * WHOLE chain, not just the latest record. */
export interface JournalFoldEntry {
  readonly chainRecords: readonly AssistantEditCheckpointRecord[];
  /** See this module's doc comment, ADDED PERSISTS ACROSS LATER TOUCHES. */
  readonly createdInRange: boolean;
  readonly oldPath: string | null;
  readonly path: string;
  readonly rootId: string;
  readonly status: ChangedFileStatus;
}

/** Build the error this module throws on a GENUINELY ambiguous rename/
 * delete-rekey identity collision (the occupant's own history is NOT
 * finished — see {@link absorbFinishedOccupant}). Prefixed
 * `journal-path-collision:` (NTH-3, review finding) so callers can branch on
 * it machine-readably instead of matching prose; names the path and states
 * the remedy (there is none automatic — the two histories cannot be merged
 * without guessing, so this changeset's view for that path must be
 * inspected via the raw journal rows). */
function collisionError(recordId: string, targetPath: string): Error {
  return new Error(
    `journal-path-collision: edit checkpoint "${recordId}" would occupy "${targetPath}", but this changeset already has a DIFFERENT, UNFINISHED tracked history at that path — inspect the individual checkpoints for "${targetPath}" directly; this cannot be resolved automatically.`
  );
}

/**
 * Resolve what a rename or delete-rekey destination CURRENTLY holds, if
 * anything, and decide whether it can be safely folded in.
 *
 * FINISHED-DELETE ABSORPTION (NTH-3, review finding): an occupant whose
 * status is `'deleted'` has a history that is TERMINAL — nothing in this
 * fold ever re-keys FROM an already-deleted entry, so its lifecycle is
 * fully resolved. Concatenating its `chainRecords` as a chronological
 * PREFIX onto the new entry's chain is therefore a WELL-DEFINED merge, not
 * a guess: it can only make the surviving entry's `revertible` conjunction
 * MORE conservative (a non-revertible or already-reverted record in the
 * absorbed history correctly taints the merged entry too), never fabricate
 * a false positive. This is exactly the "delete the old file, then move a
 * new one into its place" shape a real workflow produces — it must not deny
 * the whole changeset view.
 *
 * Any OTHER occupant status is a genuinely ambiguous collision (two live,
 * unfinished histories cannot coexist at one path) and throws
 * `journal-path-collision:` via {@link collisionError} — never silently
 * dropped.
 *
 * Returns the WHOLE occupant entry (R7, review finding) — not just its
 * `chainRecords` — so both call sites can also read `occupant.createdInRange`.
 * Absorption is the ONLY way a merged entry's `createdInRange` can become
 * `true` for a path that in fact pre-existed the range: every OTHER producer
 * derives `createdInRange` from a first record's `beforeExisted`, but an
 * absorbed occupant may itself have PRE-EXISTED the range (e.g. `delete b`
 * where `b` was never touched before in this journal). Discarding that fact
 * (the pre-R7 bug) let a merged entry inherit `createdInRange: true` from
 * the rename's OWN prior alone, which then made `isPhantomEntry` silently
 * drop a path that genuinely changed — the same silent-drop class the
 * original R2/NTH-4 fixes exist to prevent, just relocated to the
 * interaction between two fixes instead of one.
 */
function absorbFinishedOccupant(
  byPath: Map<string, JournalFoldEntry>,
  recordId: string,
  targetPath: string
): JournalFoldEntry | null {
  const occupant = byPath.get(targetPath);
  if (!occupant) {
    return null;
  }
  if (occupant.status !== 'deleted') {
    throw collisionError(recordId, targetPath);
  }
  byPath.delete(targetPath);
  return occupant;
}

/**
 * Merge `createdInRange` across an (optional) delete-rekey `prior` AND an
 * (optional) absorbed occupant (R7, review finding): the merged entry is
 * `createdInRange` ONLY when BOTH contributing histories are — absent
 * contributors count as `true` for THIS conjunct so a real contributor's
 * `false` always wins (an absent `prior` already means "path pre-existed the
 * range" via its own `?? false` fallback at each call site; an absent
 * `occupant` means "nothing was absorbed," which must never flip an
 * otherwise-true `prior` to `false`).
 *
 * Used ONLY by {@link foldDeleteRecord}. `foldRenameRecord` derives
 * `createdInRange` directly from {@link mergePreRangeIdentity}'s result
 * (`identity === null`) instead of calling this — R7b (review finding) was
 * exactly this function and the pre-R7b rename identity computation
 * disagreeing about which contributor "won," because they were two separate
 * functions expressing the same precedence rule. A delete-rekey has no
 * identity string of its own to derive from (its `identityKey` is a plain
 * `prior.oldPath ?? record.path`, unrelated to which contributor pre-existed
 * — see {@link foldDeleteRecord}), so it keeps this explicit boolean merge.
 */
function mergeCreatedInRange(
  prior: JournalFoldEntry | undefined,
  occupant: JournalFoldEntry | null
): boolean {
  return (prior?.createdInRange ?? false) && (occupant?.createdInRange ?? true);
}

/**
 * Resolve the pre-range PATH IDENTITY a rename's merged entry should carry —
 * the string counterpart to {@link mergeCreatedInRange}'s boolean, and the
 * fix for R7b (review finding): R7 corrected the `createdInRange` FLAG when
 * absorbing a finished occupant but left the identity STRING still derived
 * from `prior` alone (`prior?.oldPath ?? fromKey`), so a `prior` that was
 * itself `createdInRange` (its own `oldPath` is `null` by construction — see
 * {@link foldWriteRecord}) made `?? fromKey` fall through to an in-range-only
 * name, discarding the occupant's REAL pre-range identity
 * (`occupant.oldPath ?? occupant.path`) even when the occupant was the one
 * that actually pre-existed.
 *
 * Precedence (`prior` wins when BOTH contribute — mirrors
 * {@link absorbFinishedOccupant}'s NTH-2 trade-off: only ONE identity
 * survives per merged path):
 * - `prior` is either MISSING (per the FOLD KEYING RULE in this module's doc
 *   comment, a rename `fromPath` with no accumulator entry means the journal
 *   never saw that file created in-range, so it must have pre-existed — the
 *   `fallbackKey` argument IS that implicit identity) or present with
 *   `createdInRange: false` (an explicit pre-range contributor, chain-
 *   compressed via its own `oldPath`): either way `prior` pre-existed, and
 *   wins outright — even over an occupant that ALSO pre-existed.
 * - Otherwise, when `occupant` pre-existed (`createdInRange: false`), its own
 *   identity (`occupant.oldPath ?? occupant.path`) is the one to surface —
 *   the fact R7b left undiscovered.
 * - Otherwise NEITHER contributor pre-existed the range: `null`, meaning
 *   `createdInRange` for the merged entry (derived as `identity === null` at
 *   the call site — ONE source of truth, not two functions that can drift).
 */
function mergePreRangeIdentity(
  prior: JournalFoldEntry | undefined,
  occupant: JournalFoldEntry | null,
  fallbackKey: string
): string | null {
  if (!prior?.createdInRange) {
    return prior?.oldPath ?? fallbackKey;
  }
  if (occupant && !occupant.createdInRange) {
    return occupant.oldPath ?? occupant.path;
  }
  return null;
}

/** Fold ONE `rename` record into `byPath` — split out of
 * {@link foldJournalRecords} to keep that function's cognitive complexity
 * under the lint threshold. See the module doc comment for the keying rule
 * and {@link absorbFinishedOccupant} for the collision policy. */
function foldRenameRecord(
  byPath: Map<string, JournalFoldEntry>,
  record: AssistantEditCheckpointRecord
): void {
  if (record.fromPath === null) {
    // Data-integrity violation, not a business scenario: `recordEditCheckpoint`
    // ALWAYS sets `from_path` for a rename row. No silent coercion to ''.
    throw new Error(`edit checkpoint "${record.id}" has op "rename" but no fromPath`);
  }
  const fromKey = record.fromPath;
  const occupant =
    fromKey === record.path ? null : absorbFinishedOccupant(byPath, record.id, record.path);
  const prior = byPath.get(fromKey);
  byPath.delete(fromKey);
  const renameChain = prior ? [...prior.chainRecords, record] : [record];
  const chainRecords = occupant ? [...occupant.chainRecords, ...renameChain] : renameChain;
  const identity = mergePreRangeIdentity(prior, occupant, fromKey);
  byPath.set(record.path, {
    chainRecords,
    createdInRange: identity === null,
    oldPath: identity === record.path ? null : identity,
    path: record.path,
    rootId: record.rootId,
    status: identity === null ? 'added' : identity === record.path ? 'modified' : 'renamed',
  });
}

/** Fold ONE `delete` record into `byPath` — split out of
 * {@link foldJournalRecords}; see the module doc comment's DELETE OF A
 * RENAMED PATH section and {@link absorbFinishedOccupant} for the collision
 * policy. */
function foldDeleteRecord(
  byPath: Map<string, JournalFoldEntry>,
  record: AssistantEditCheckpointRecord
): void {
  const prior = byPath.get(record.path);
  byPath.delete(record.path);
  const chainRecords = prior ? [...prior.chainRecords, record] : [record];
  // DELETE OF A RENAMED PATH: report at the ORIGINAL pre-range identity
  // when this logical file went through a rename.
  const identityKey = prior?.oldPath ?? record.path;
  const occupant =
    identityKey === record.path ? null : absorbFinishedOccupant(byPath, record.id, identityKey);
  const finalChain = occupant ? [...occupant.chainRecords, ...chainRecords] : chainRecords;
  byPath.set(identityKey, {
    chainRecords: finalChain,
    createdInRange: mergeCreatedInRange(prior, occupant),
    oldPath: null,
    path: identityKey,
    rootId: record.rootId,
    status: 'deleted',
  });
}

/**
 * Fold ONE `write`/`string_replace` record into `byPath` — split out of
 * {@link foldJournalRecords}; see the module doc comment's ADDED PERSISTS
 * ACROSS LATER TOUCHES section. `createdInRange` is set ONCE by the FIRST
 * record ever seen for this key and persists across every later touch.
 *
 * R6 (review finding): a write ALSO carries `prior.oldPath` through
 * unchanged (when the entry is not `createdInRange`) and keeps
 * `status: 'renamed'` when one is present — a write is a per-CONTENT event,
 * never a per-IDENTITY one, so it must never erase the rename identity
 * `foldRenameRecord`/`foldDeleteRecord` already carry. Before this fix, a
 * write between two rename hops (or before a delete) silently reset
 * `oldPath` to `null` and `status` to `'modified'`, which then defeated the
 * delete-rekey (R4) and chain-compression rules for THAT record even though
 * both were correctly implemented — the bug lived entirely here, in the one
 * fold branch nothing else reads from.
 */
function foldWriteRecord(
  byPath: Map<string, JournalFoldEntry>,
  record: AssistantEditCheckpointRecord
): void {
  const prior = byPath.get(record.path);
  const chainRecords = prior ? [...prior.chainRecords, record] : [record];
  const createdInRange = prior?.createdInRange ?? !record.beforeExisted;
  const oldPath = createdInRange ? null : (prior?.oldPath ?? null);
  byPath.set(record.path, {
    chainRecords,
    createdInRange,
    oldPath,
    path: record.path,
    rootId: record.rootId,
    status: createdInRange ? 'added' : oldPath === null ? 'modified' : 'renamed',
  });
}

/** Pure per-path latest-wins fold over journal records — see this module's
 * doc comment for the rename-keying rule. Exported directly for falsifiable
 * unit testing without a database. */
export function foldJournalRecords(
  records: readonly AssistantEditCheckpointRecord[]
): readonly JournalFoldEntry[] {
  const byPath = new Map<string, JournalFoldEntry>();

  for (const record of records) {
    if (record.op === 'rename') {
      foldRenameRecord(byPath, record);
    } else if (record.op === 'delete') {
      foldDeleteRecord(byPath, record);
    } else {
      foldWriteRecord(byPath, record);
    }
  }

  return Array.from(byPath.values());
}

/**
 * True when a fold entry has NO net effect from outside this changeset: it
 * was CREATED and later DELETED entirely within the range (`createdInRange`
 * + `status: 'deleted'`) — the path did not exist before the range and does
 * not exist after it either, through any name it held in between (R4/R6
 * already ensure a created-then-renamed-then-deleted file re-keys to ITS
 * OWN identity, not a stale intermediate name, so this check is safe to
 * apply uniformly).
 *
 * Consumers (NOT `foldJournalRecords` itself, which stays the complete raw
 * fold for direct testability) DROP such entries — from the `ChangesetView`
 * listing AND from `fileDiff` lookups — per NTH-4 (review finding). This is
 * an intentional, documented OMISSION, not a silent drop of real
 * information: unlike an `expired` capture (something REALLY changed and we
 * merely can't show the old content — that entry still appears, honestly
 * marked non-revertible), a phantom entry represents NOTHING changing at
 * all, so there is nothing honest left to display.
 */
function isPhantomEntry(entry: JournalFoldEntry): boolean {
  return entry.createdInRange && entry.status === 'deleted';
}

/** `revertible` = every contributing record has a revertible captureStatus AND
 * none is already reverted. An entry with an `expired`/`skipped_*` record in
 * its chain, or one with ANY reverted record, is honestly non-revertible —
 * but it still appears (never silently omitted). */
function isEntryRevertible(entry: JournalFoldEntry): boolean {
  return entry.chainRecords.every(
    (record) => isRevertibleCaptureStatus(record.captureStatus) && record.revertedAt === null
  );
}

export function journalFoldEntryToChangedFileEntry(entry: JournalFoldEntry): ChangedFileEntry {
  return {
    additions: null,
    deletions: null,
    ...(entry.oldPath === null ? {} : { oldPath: entry.oldPath }),
    path: entry.path,
    repositoryRoot: null,
    revertible: isEntryRevertible(entry),
    rootId: entry.rootId,
    status: entry.status,
    worktreePath: null,
  };
}

async function loadJournalRecords(
  db: EditCheckpointDatabase,
  changeset: JournalChangeset
): Promise<GitResult<readonly AssistantEditCheckpointRecord[]>> {
  if (changeset.kind === 'agent-run') {
    const records = await listRunCheckpoints(db, changeset.runId);
    return { ok: true, value: records };
  }
  return await listRunRangeCheckpoints(db, {
    fromRunId: changeset.fromRunId,
    threadId: changeset.threadId,
    ...(changeset.toRunId === undefined ? {} : { toRunId: changeset.toRunId }),
  });
}

/**
 * Resolve a journal-sourced `ChangesetView`. `totalAdditions`/`totalDeletions`
 * are always `null` — see `ChangesetView`'s doc comment in
 * `packages/types/src/changeset.ts` for the settled contract: `null` means
 * "this source cannot report totals," which every journal-backed changeset
 * is, since the journal carries no line counts at all.
 *
 * An empty run/range yields an empty `files: []`, NOT an error —
 * `loadJournalRecords` already returns `ok: true, value: []` for that case
 * (see `listRunRangeCheckpoints`'s doc comment).
 *
 * A path CREATED and DELETED entirely within this changeset is dropped from
 * `files` — see {@link isPhantomEntry} (NTH-4, review finding).
 */
export async function resolveJournalChangesetView(
  db: EditCheckpointDatabase,
  changeset: JournalChangeset
): Promise<GitResult<ChangesetView>> {
  const recordsResult = await loadJournalRecords(db, changeset);
  if (!recordsResult.ok) {
    return recordsResult;
  }
  const files = foldJournalRecords(recordsResult.value)
    .filter((entry) => !isPhantomEntry(entry))
    .map(journalFoldEntryToChangedFileEntry);
  return { ok: true, value: { changeset, files, totalAdditions: null, totalDeletions: null } };
}

/**
 * Resolve the OLD side of a journal fileDiff: the `before_content` of the
 * FIRST unreverted record in the entry's chain.
 *
 * CONTROLLER RULING (supersedes the plan's visible deliberation): whenever
 * that record's `before_existed` is true but its `before_content` is null —
 * for ANY reason (retention-expired, `skipped_binary`, `skipped_too_large`,
 * or a `rename` record, which by design never captures content) — this
 * returns a typed `ok: false` error prefixed `journal-content-expired:`. No
 * new `StructuredFileDiffContent` state, no `full` with a fabricated null
 * old side and a note: v1 is an honest typed error; the UX affordance (e.g.
 * falling back to current content for a content-preserving pure rename) is a
 * W4 follow-up.
 *
 * `status: 'added'` entries skip this lookup entirely: the FIRST record's own
 * `beforeExisted: false` already means there is legitimately no "before" —
 * `oldContent: null` is not an error there.
 *
 * If every record in the chain is already reverted (no "first unreverted"
 * record exists), that is ALSO reported via `journal-content-expired:` — the
 * changeset's own before-state is no longer knowable from the journal once
 * every entry that captured it has been undone.
 */
async function resolveOldContent(
  db: EditCheckpointDatabase,
  entry: JournalFoldEntry
): Promise<GitResult<string | null>> {
  if (entry.status === 'added') {
    return { ok: true, value: null };
  }
  const firstUnreverted = entry.chainRecords.find((record) => record.revertedAt === null);
  if (!firstUnreverted) {
    return {
      error: `journal-content-expired: every checkpoint for "${entry.path}" has already been reverted; no before-content is available.`,
      ok: false,
    };
  }
  const rowResult = await readCheckpointBeforeContent(db, firstUnreverted.id);
  if (!rowResult.ok) {
    return { error: `journal-content-expired: ${rowResult.error}`, ok: false };
  }
  if (rowResult.value.beforeExisted && rowResult.value.beforeContent === null) {
    return {
      error: `journal-content-expired: before-content for checkpoint "${firstUnreverted.id}" (path "${firstUnreverted.path}") is unavailable (expired retention, skipped binary/oversized capture, or a content-free rename record).`,
      ok: false,
    };
  }
  return { ok: true, value: rowResult.value.beforeContent };
}

/** One side's on-disk read outcome for the NEW side of a journal fileDiff —
 * mirrors `git-structured-diff.ts`'s `readWorktreeFile` discipline (leaf-symlink
 * safe, size-guarded via a single `open`+`fstat`, never a naive `fs.readFile`)
 * without importing that module's private helper (not exported; see this
 * repo's line-count ceiling on `git-structured-diff.ts`). */
type NewSideRead =
  | { readonly content: Buffer; readonly kind: 'present' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'over-cap'; readonly size: number };

async function readCurrentFileContent(
  rootCwd: string,
  relativePath: string
): Promise<GitResult<NewSideRead>> {
  const containment = await assertUntrackedDiffPathContained(rootCwd, relativePath);
  if (!containment.ok) {
    return containment;
  }
  const resolved = path.resolve(rootCwd, relativePath);
  try {
    const lstats = await lstat(resolved);
    if (lstats.isSymbolicLink()) {
      const target = await readlink(resolved);
      return { ok: true, value: { content: Buffer.from(target, 'utf8'), kind: 'present' } };
    }
    const handle = await open(resolved, 'r');
    try {
      const stats = await handle.stat();
      if (stats.size > STRUCTURED_DIFF_CONTENT_CAP_BYTES) {
        return { ok: true, value: { kind: 'over-cap', size: stats.size } };
      }
      const buffer = await handle.readFile();
      return { ok: true, value: { content: buffer, kind: 'present' } };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, value: { kind: 'absent' } };
    }
    return { error: toErrorMessage(error), ok: false };
  }
}

/**
 * `hunks` is always `[]` here — a journal diff's old side is a raw DB-stored
 * string, not a git ref, so there is no `git diff` invocation to compute
 * hunk ranges from at all (see `hunks`' doc comment on `StructuredFileDiff`
 * in `packages/types/src/changeset.ts` for the full, settled ruling: `full`
 * content with empty `hunks` is not a contradiction — `full` only promises
 * complete text on both sides, never that hunks were computed).
 */
function assembleJournalDiff(
  entry: JournalFoldEntry,
  oldContent: string | null,
  newSide: NewSideRead
): StructuredFileDiff {
  const base = {
    ...(entry.oldPath === null ? {} : { oldPath: entry.oldPath }),
    path: entry.path,
    status: entry.status,
  };
  if (newSide.kind === 'absent') {
    return {
      ...base,
      additions: null,
      content: { kind: 'full', newContent: null, oldContent },
      deletions: null,
      hunks: [],
    };
  }
  if (newSide.kind === 'over-cap') {
    // No git-diff-generated preview is available for a journal-vs-disk
    // comparison (there is no git ref for the DB-stored old side) — an empty
    // `hunkText` is honest; `reason` alone signals "too large to preview".
    return {
      ...base,
      additions: null,
      content: {
        hunkText: '',
        hunkTextTruncated: false,
        kind: 'hunks-only',
        reason: 'over-cap-new',
      },
      deletions: null,
      hunks: [],
    };
  }
  if (newSide.content.includes(0)) {
    return { ...base, additions: null, content: { kind: 'binary' }, deletions: null, hunks: [] };
  }
  return {
    ...base,
    additions: null,
    content: { kind: 'full', newContent: newSide.content.toString('utf8'), oldContent },
    deletions: null,
    hunks: [],
  };
}

export interface JournalFileDiffDeps {
  readonly db: EditCheckpointDatabase;
  readonly resolveRootCwd: (rootId: unknown) => Promise<RootCwdResult>;
}

/**
 * Per-file structured diff for a journal-sourced changeset. `path` is matched
 * against the SAME fold this changeset's `resolveJournalChangesetView` would
 * produce, so "no such path" is reported identically either way.
 *
 * A `status: 'deleted'` entry's new side is always `null` (never a disk read —
 * the file is gone by definition). Every other status reads the CURRENT
 * on-disk file at the entry's own `rootId` — never the caller-supplied
 * `rootId` the top-level service dispatch receives, which is a git-scope-only
 * concept; journal entries are git-independent and carry their own root.
 */
export async function resolveJournalFileDiff(
  deps: JournalFileDiffDeps,
  changeset: JournalChangeset,
  path: string
): Promise<GitResult<StructuredFileDiff>> {
  const recordsResult = await loadJournalRecords(deps.db, changeset);
  if (!recordsResult.ok) {
    return recordsResult;
  }
  const entry = foldJournalRecords(recordsResult.value)
    .filter((candidate) => !isPhantomEntry(candidate))
    .find((candidate) => candidate.path === path);
  if (!entry) {
    return { error: `no journaled change for path "${path}" in this changeset`, ok: false };
  }

  const oldContentResult = await resolveOldContent(deps.db, entry);
  if (!oldContentResult.ok) {
    return oldContentResult;
  }

  if (entry.status === 'deleted') {
    return {
      ok: true,
      value: {
        ...(entry.oldPath === null ? {} : { oldPath: entry.oldPath }),
        additions: null,
        content: { kind: 'full', newContent: null, oldContent: oldContentResult.value },
        deletions: null,
        hunks: [],
        path: entry.path,
        status: entry.status,
      },
    };
  }

  const rootCwdResult = await deps.resolveRootCwd(entry.rootId);
  if (!rootCwdResult.ok) {
    return rootCwdResult;
  }
  const newRead = await readCurrentFileContent(rootCwdResult.value, entry.path);
  if (!newRead.ok) {
    return newRead;
  }
  return { ok: true, value: assembleJournalDiff(entry, oldContentResult.value, newRead.value) };
}
