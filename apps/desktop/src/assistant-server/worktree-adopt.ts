/**
 * Adoption, per-checkout status, and shell reconciliation for managed
 * worktrees (BST-1392, spec §6.4, §10) — plus the `list()` inventory ⋈ ledger
 * projection (`inventoryListEntry`/`ghostListEntry`/`resolveUsability`), which
 * joined this file for the same reason: `worktree-service.ts` sits at the
 * 1000-line Biome ceiling. The three OPERATIONS (adopt, checkoutStatus,
 * reconcileFromShell) share one discipline: they only ever act on a worktree
 * the LIVE GIT INVENTORY already reports, so a caller-supplied path can never
 * reach git or the ledger on its own authority. The list-entry PROJECTION
 * shares no such discipline of its own — it is pure, reads nothing external —
 * but it directly informs `adoptWorktree`'s primary-checkout refusal (both
 * derive "primary" from `descriptor.path === repositoryRoot`), so keeping them
 * in one file keeps that invariant visibly in one place.
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import type {
  GitInventory,
  GitResult,
  ManagedWorktreeRow,
  WorktreeAdoptParams,
  WorktreeCheckoutStatus,
  WorktreeDescriptor,
  WorktreeListEntry,
  WorktreeSettings,
} from '@brainstrike/types';
import {
  describeFailure,
  type GitCommandRunner,
  invokeGitHookFree,
  parsePorcelainV2Z,
} from './git-service';
import { generateWorkspaceSnapshotId } from './snapshot-repository';
import type { WorktreeLedger } from './worktree-ledger';
import { externalToolForPath } from './worktree-paths';

const logger = createLogger('WorktreeAdopt');

const GIT_DEFAULT_TIMEOUT_MS = 30_000;

export interface WorktreeAdoptDeps {
  readonly ledger: Pick<WorktreeLedger, 'getByPath' | 'insert' | 'listActive'>;
  readonly readSettings: () => Promise<WorktreeSettings>;
  /**
   * `forceFresh` maps to `GitInventoryService.getSnapshot({ maxAgeMs: 0 })`
   * (main.ts) — a build GUARANTEED to start after the call, not merely a
   * cache-bust. Default (no options / `forceFresh` absent or false) may serve
   * a snapshot up to `GIT_INVENTORY_SNAPSHOT_TTL_MS` old, or older still if
   * the watcher hasn't marked it dirty yet.
   */
  readonly resolveInventory: (options?: { readonly forceFresh?: boolean }) => Promise<GitInventory>;
  readonly resolveRootPaths: () => Promise<
    readonly { readonly id: string; readonly path: string }[]
  >;
  readonly run: GitCommandRunner;
}

interface LocatedWorktree {
  readonly descriptor: WorktreeDescriptor;
  readonly repoCommonDir: string;
  readonly repositoryRoot: string;
}

function locate(inventory: GitInventory, target: string): LocatedWorktree | null {
  for (const repository of inventory.repositories) {
    for (const descriptor of repository.worktrees) {
      if (descriptor.path === target) {
        return {
          descriptor,
          repoCommonDir: repository.identity.gitCommonDir,
          repositoryRoot: repository.identity.repositoryRoot,
        };
      }
    }
  }
  return null;
}

function isWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

/**
 * The ONE reachability rule, shared by adoption (`assertReachable`) and the
 * picker-less mount authorizer (`isAuthorizedWorktreeMountPath`) so the two
 * cannot drift apart STRUCTURALLY (PR #2681 review — co-location alone left
 * two verbatim copies): a checkout is reachable when a granted workspace root
 * contains it, or when it sits under the realpath'd managed directory. The
 * managed-directory arm reads settings + realpath only — never the inventory.
 */
async function isReachableCheckout(
  deps: Pick<WorktreeAdoptDeps, 'readSettings'>,
  checkoutPath: string,
  containment: WorktreeDescriptor['containment']
): Promise<boolean> {
  if (containment !== 'outside-roots') {
    return true;
  }
  const settings = await deps.readSettings();
  try {
    const managed = await fsPromises.realpath(settings.managedDirectory);
    return isWithin(managed, checkoutPath);
  } catch (error) {
    // Routine: the managed directory has simply never been created.
    logger.debug('managed directory could not be resolved during reachability check', { error });
    return false;
  }
}

/**
 * A worktree may be adopted only when the app can actually REACH it: inside a
 * granted workspace root, or under the managed directory. `resolveUsability`
 * treats "has a ledger row" as authorization, so adopting an unreachable path
 * would mint a row that reads `usable: true` while every operation on it would
 * fail. Refuse loudly and name the remedy instead.
 */
async function assertReachable(
  deps: WorktreeAdoptDeps,
  descriptor: WorktreeDescriptor
): Promise<GitResult<null>> {
  if (await isReachableCheckout(deps, descriptor.path, descriptor.containment)) {
    return { ok: true, value: null };
  }
  return {
    error: `The worktree at "${descriptor.path}" is outside every open folder. Grant access to its folder first, then adopt it.`,
    ok: false,
  };
}

/**
 * Mount authorization for the picker-less `fs:addRootByPath` grant (spec §6.2,
 * widened in the BST-1392 follow-up): a candidate is authorized exactly when a
 * LIVE ledger row exists for its realpath AND the checkout passes the SAME
 * `isReachableCheckout` predicate adoption applies — under the realpath'd
 * managed directory, or inside a granted workspace root per a FORCED-FRESH
 * inventory's containment. Forced-fresh is load-bearing (PR #2681 review): a
 * `roots` table write never dirties the inventory cache, so the default
 * cached read could authorize against a root the user closed seconds ago (or
 * refuse one they just granted) for up to the cache TTL. The call is
 * user-initiated and off every latency-critical path, so the bounded rebuild
 * is an acceptable price for the documented "live containment" rule being
 * literally true.
 *
 * An outside-roots path (e.g. its granting root was disconnected after
 * adoption) stays refused — a ledger row alone is never a mount grant. An
 * unavailable inventory refuses only the arm that NEEDS it: the managed-
 * directory arm stays inventory-free, and the failure surfaces at WARN
 * (NO SILENT FALLBACKS), never a silent debug-only `false`.
 */
export async function isAuthorizedWorktreeMountPath(
  deps: Pick<WorktreeAdoptDeps, 'ledger' | 'readSettings' | 'resolveInventory'>,
  candidate: string
): Promise<boolean> {
  let realCandidate: string;
  try {
    realCandidate = await fsPromises.realpath(candidate);
  } catch (error) {
    // Routine: the candidate path does not exist (or a component vanished).
    logger.debug('mount authorization refused an unresolvable candidate path', {
      candidate,
      error,
    });
    return false;
  }
  try {
    const row = await deps.ledger.getByPath(realCandidate);
    if (row === null || row.archivedAt !== null) {
      return false;
    }
    let containment: WorktreeDescriptor['containment'] = 'outside-roots';
    try {
      const located = locate(await deps.resolveInventory({ forceFresh: true }), realCandidate);
      containment = located?.descriptor.containment ?? 'outside-roots';
    } catch (error) {
      // Inventory unavailability (stopped service, failed build, DB error) is
      // an infrastructure signal, not "not a worktree we created" — and it
      // must not take the inventory-free managed-directory arm down with it.
      logger.warn('inventory unavailable during mount authorization; managed-directory arm only', {
        candidate,
        error,
      });
    }
    return await isReachableCheckout(deps, realCandidate, containment);
  } catch (error) {
    // A ledger or settings read failure is likewise a real signal — refuse,
    // but never silently.
    logger.warn('worktree mount authorization check failed', { candidate, error });
    return false;
  }
}

export async function adoptWorktree(
  deps: WorktreeAdoptDeps,
  params: WorktreeAdoptParams
): Promise<GitResult<ManagedWorktreeRow>> {
  const inventory = await deps.resolveInventory();
  const located = locate(inventory, params.path);
  if (!located) {
    return {
      error: `No worktree at "${params.path}" is visible in the workspace inventory, so it cannot be adopted.`,
      ok: false,
    };
  }
  const { descriptor, repoCommonDir, repositoryRoot } = located;
  if (descriptor.path === repositoryRoot) {
    return {
      error: `The worktree at "${params.path}" is the repository's primary checkout — use Hand off to Local instead.`,
      ok: false,
    };
  }
  if (descriptor.prunableReason !== null) {
    return {
      error: `The worktree at "${params.path}" is prunable (${descriptor.prunableReason}) and cannot be adopted.`,
      ok: false,
    };
  }
  if (descriptor.trust === 'unvalidated') {
    return {
      error:
        descriptor.trustReason ??
        `The worktree at "${params.path}" could not be verified against its own .git.`,
      ok: false,
    };
  }
  if (descriptor.lockedReason !== null) {
    // A locked worktree adopts into a row that is neither usable
    // (`resolveUsability` keeps reporting `Locked: <reason>`) nor archivable
    // (`git worktree remove` refuses a locked worktree even with `--force`) —
    // a dead-end row the user could only escape by unlocking out-of-band.
    // Refuse loudly instead of minting it.
    return {
      error: `The worktree at "${params.path}" is locked (${descriptor.lockedReason}) and cannot be adopted — unlock it (\`git worktree unlock\`) first.`,
      ok: false,
    };
  }
  const reachable = await assertReachable(deps, descriptor);
  if (!reachable.ok) {
    return reachable;
  }
  const existing = await deps.ledger.getByPath(descriptor.path);
  if (existing !== null) {
    return {
      error:
        existing.archivedAt === null
          ? `BrainStrike already manages the worktree at "${descriptor.path}".`
          : `BrainStrike archived a worktree at "${descriptor.path}" — restore that one instead of adopting a new checkout at the same path.`,
      ok: false,
    };
  }
  const headRun = await invokeGitHookFree(
    (args, timeoutMs = GIT_DEFAULT_TIMEOUT_MS) =>
      deps.run({ args, cwd: descriptor.path, timeoutMs }),
    ['rev-parse', 'HEAD']
  );
  if (headRun.exitCode !== 0) {
    return { error: describeFailure(headRun), ok: false };
  }
  const row: ManagedWorktreeRow = {
    archivedAt: null,
    archiveSnapshotRef: null,
    // The worktree existed before BrainStrike knew about it, so there is no
    // creation base to record. HEAD-at-adoption is the honest reference point:
    // "unpushed" then means "committed here since we started managing it".
    baseRef: headRun.stdout.trim(),
    branch: descriptor.branch,
    createdAt: new Date().toISOString(),
    createdBy: params.createdBy,
    id: generateWorkspaceSnapshotId(),
    path: descriptor.path,
    repoCommonDir,
    runId: params.runId ?? null,
    setupOutput: null,
    setupReason: null,
    // Adoption never runs setup: the worktree already exists and the user did
    // not ask for a repository script to run (BST-1455 owns consent).
    setupStatus: 'none',
    threadId: params.threadId ?? null,
  };
  await deps.ledger.insert(row);
  return { ok: true, value: row };
}

/** One `git worktree move` inferred (never rewritten) during a shell reconcile. */
export interface LikelyWorktreeMove {
  readonly branch: string;
  readonly newPath: string;
  readonly vanishedLedgerId: string;
  readonly vanishedPath: string;
}

export interface WorktreeShellReconcileResult {
  readonly adopted: readonly ManagedWorktreeRow[];
  /**
   * New, unmanaged paths that were NOT adopted because their branch matches a
   * ledger row that vanished from disk in this SAME delta — i.e. a
   * `git worktree move` (reachable through composite shell commands even
   * though the scanner does not trigger on a bare `move`). Adopting the
   * destination as a brand-new row would fabricate a false "created" event
   * and silently orphan the original row's identity, thread, and lineage as
   * an unexplained ghost. This is reported loudly instead: the ledger
   * identity is NOT rewritten here (ticket-worthy real feature, not a
   * bounded fail-closed guard), so the vanished row still surfaces via
   * `vanishedLedgerIds` as a "missing on disk" ghost until a human or a
   * future move-aware reconciler resolves it.
   */
  readonly likelyMoves: readonly LikelyWorktreeMove[];
  /**
   * Live ledger rows whose directory is no longer on disk. Reported, NOT
   * archived: an archive carries a restorable snapshot, and a `git worktree
   * remove` run in a shell produced none. `list()` already renders these as
   * ghost rows reading "missing on disk — restore it or archive it", which is
   * the honest surface for a removal the app did not perform.
   */
  readonly vanishedLedgerIds: readonly string[];
}

type ReconcileCandidate =
  | { readonly kind: 'attributable' }
  | { readonly kind: 'likely-move'; readonly move: LikelyWorktreeMove }
  | { readonly kind: 'not-attributable' };

/**
 * Pure classification of ONE on-disk worktree against the delta this
 * reconcile pass is looking at — kept out of `reconcileWorktreesFromShell`
 * itself so that function's own branching (repository lookup, the
 * has-a-snapshot fork, the adopt/skip result) stays legible on its own.
 *
 * `'likely-move'` is the `git worktree move` guard (BST-1392 review, P1): a
 * move is reachable through composite shell commands even though the scanner
 * does not trigger on a bare `move`. Naively adopting the destination would
 * create a NEW ledger row (a false "created" event) while the original row
 * silently becomes an unexplained ghost — identity, thread, and lineage all
 * lost. A branch match against a row that vanished in this SAME delta is the
 * bounded, fail-closed signal for "this is probably that row's worktree,
 * moved". Ledger identity is deliberately NOT rewritten here — that is a
 * real, ticket-worthy feature (matching move semantics correctly needs more
 * than a branch heuristic), not something to improvise inline.
 */
function classifyReconcileCandidate(
  descriptor: WorktreeDescriptor,
  repositoryRoot: string,
  precedingWorktreePaths: ReadonlySet<string>,
  vanishedRows: readonly ManagedWorktreeRow[]
): ReconcileCandidate {
  // The primary checkout is not a managed worktree; adopting it would put the
  // user's own clone under archive/restore machinery.
  if (descriptor.path === repositoryRoot) {
    return { kind: 'not-attributable' };
  }
  // Existed BEFORE this command ran — not this run's doing, whatever it is.
  // Never attribute it here, even if it is genuinely unmanaged.
  if (precedingWorktreePaths.has(descriptor.path)) {
    return { kind: 'not-attributable' };
  }
  const { branch } = descriptor;
  const movedFrom = branch === null ? undefined : vanishedRows.find((row) => row.branch === branch);
  if (branch !== null && movedFrom) {
    return {
      kind: 'likely-move',
      move: {
        branch,
        newPath: descriptor.path,
        vanishedLedgerId: movedFrom.id,
        vanishedPath: movedFrom.path,
      },
    };
  }
  return { kind: 'attributable' };
}

/**
 * The attributable-delta pass: classify and (unless it is a likely move)
 * adopt every on-disk worktree that is new since `precedingWorktreePaths` was
 * captured. Split out of `reconcileWorktreesFromShell` purely to keep that
 * function's own branching (repository lookup, the has-a-snapshot fork)
 * legible — this loop is the only place that needs the classification result.
 */
async function adoptAttributableWorktrees(
  deps: WorktreeAdoptDeps,
  params: {
    readonly precedingWorktreePaths: ReadonlySet<string>;
    readonly repository: GitInventory['repositories'][number];
    readonly runId?: string;
    readonly threadId?: string;
    readonly vanishedRows: readonly ManagedWorktreeRow[];
  }
): Promise<{ readonly adopted: ManagedWorktreeRow[]; readonly likelyMoves: LikelyWorktreeMove[] }> {
  const adopted: ManagedWorktreeRow[] = [];
  const likelyMoves: LikelyWorktreeMove[] = [];
  for (const descriptor of params.repository.worktrees) {
    const candidate = classifyReconcileCandidate(
      descriptor,
      params.repository.identity.repositoryRoot,
      params.precedingWorktreePaths,
      params.vanishedRows
    );
    if (candidate.kind === 'not-attributable') {
      continue;
    }
    if (candidate.kind === 'likely-move') {
      likelyMoves.push(candidate.move);
      logger.warn(
        'shell reconcile skipped a likely `git worktree move`, not adopting',
        candidate.move
      );
      continue;
    }
    const result = await adoptWorktree(deps, {
      createdBy: 'agent',
      path: descriptor.path,
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.threadId ? { threadId: params.threadId } : {}),
    });
    if (result.ok) {
      adopted.push(result.value);
      continue;
    }
    logger.debug('shell reconcile skipped a worktree', {
      path: descriptor.path,
      reason: result.error,
    });
  }
  return { adopted, likelyMoves };
}

/**
 * Re-derive the ledger for ONE repository after the agent's shell touched
 * worktrees (spec §6.4). Nothing here trusts the command text: the live
 * inventory is the authority for what exists, so an unparseable
 * `git worktree add "$DIR/$(date +%s)"` reconciles exactly as well as a literal
 * path would.
 *
 * Adoption is limited to the delta from a verified pre-command snapshot. A
 * worktree that already existed before this command is not attributable to
 * this run, even when it has no ledger row. Without that snapshot the safe
 * result is to report vanished rows while adopting nothing.
 */
export async function reconcileWorktreesFromShell(
  deps: WorktreeAdoptDeps,
  params: {
    readonly precedingWorktreePaths: ReadonlySet<string> | undefined;
    readonly repoCommonDir: string;
    readonly runId?: string;
    readonly threadId?: string;
  }
): Promise<GitResult<WorktreeShellReconcileResult>> {
  // Force a fresh read (BST-1392 review round, W5 e2e): this call runs
  // milliseconds after the agent's own shell command exited — reliably well
  // under both the inventory's 5s TTL and the fs watcher's 300-2000ms
  // coalescing window — so a cached read HERE deterministically reports the
  // worktree the command just created as "not there" on every single call,
  // making `adopted` empty for every real shell-created worktree (verified:
  // command exitCode 0, worktree present on disk, this read's own
  // `onDiskPaths` still missing it).
  //
  // `snapshotWorktreePaths` (execute-command-correlation.ts), the PRE-command
  // guard read, deliberately keeps the cached default instead. Named
  // consequence, correctly signed: `descriptor.path` IN the preceding
  // snapshot is what SKIPS adoption below, so a snapshot that UNDER-includes
  // (misses something that already existed) does NOT skip it — that path
  // gets adopted and mis-attributed to this run, the bad direction.
  // Over-inclusion only SUPPRESSES adoption of something that may be
  // genuinely new — safe, boring. Unlike the post-command read above, this
  // isn't a guarantee triggered by this function's own timing: it would need
  // an UNRELATED process to create a worktree in the exact narrow pre-command
  // window the cache hasn't yet observed. In practice that residual risk is
  // narrowed further still — `adoptWorktree`'s own `ledger.getByPath` check
  // (below) refuses anything with an existing ledger row, live or archived,
  // so under-inclusion can only mis-attribute a worktree that is BOTH new to
  // the cache AND never previously known to BrainStrike at all: a genuinely
  // externally-created checkout that lands inside that cache window. Forcing
  // freshness here would not close even that narrow race outright (there is
  // always some latency before "now"), so there is no comparable, always-
  // reproducing failure — the post-command guarantee above — to justify the
  // cost.
  const inventory = await deps.resolveInventory({ forceFresh: true });
  const repository = inventory.repositories.find(
    (candidate) => candidate.identity.gitCommonDir === params.repoCommonDir
  );
  if (!repository) {
    return {
      error: `No repository with common dir "${params.repoCommonDir}" is in the workspace inventory.`,
      ok: false,
    };
  }
  const onDiskPaths = new Set(repository.worktrees.map((descriptor) => descriptor.path));
  const activeRows = await deps.ledger.listActive();
  // A single pass (RD 6): both the ghost-row ids AND the full rows are needed
  // below (the move guard matches on `branch`, `id`, and `path`), so a
  // filter().map() chain would just force a second derivation from the same
  // predicate.
  const vanishedRows: ManagedWorktreeRow[] = [];
  for (const row of activeRows) {
    if (row.repoCommonDir === params.repoCommonDir && !onDiskPaths.has(row.path)) {
      vanishedRows.push(row);
    }
  }
  const vanishedLedgerIds = vanishedRows.map((row) => row.id);

  if (params.precedingWorktreePaths === undefined) {
    // Mis-attribution guard (BST-1392 review): without a verified pre-command
    // snapshot, there is no honest way to tell "this run created it" from
    // "this was already sitting on disk" — a scanner false positive
    // (quote-blindness on a heredoc/quoted string) plus an unconditional
    // adopt-everything-unmanaged pass would durably attribute a user's own
    // externally-created checkout (Claude Code, Codex, ...) to this run.
    // Fail closed: report what vanished (safe either way), adopt nothing.
    logger.warn('shell reconcile skipped adoption: no pre-command worktree snapshot was captured', {
      repoCommonDir: params.repoCommonDir,
    });
    return { ok: true, value: { adopted: [], likelyMoves: [], vanishedLedgerIds } };
  }
  const { adopted, likelyMoves } = await adoptAttributableWorktrees(deps, {
    precedingWorktreePaths: params.precedingWorktreePaths,
    repository,
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.threadId ? { threadId: params.threadId } : {}),
    vanishedRows,
  });
  return { ok: true, value: { adopted, likelyMoves, vanishedLedgerIds } };
}

/**
 * The working-tree + upstream state of ONE checkout. The path must be a
 * worktree the live inventory reports — the same authority `adoptWorktree`
 * uses — so a caller-supplied path can never make git run somewhere arbitrary.
 *
 * Parsing reuses the production `parsePorcelainV2Z`; a second parser for the
 * same format would be a second source of truth for what "clean" means.
 */
export async function readCheckoutStatus(
  deps: WorktreeAdoptDeps,
  params: { readonly path: string }
): Promise<GitResult<WorktreeCheckoutStatus>> {
  const inventory = await deps.resolveInventory();
  const located = locate(inventory, params.path);
  if (!located) {
    return {
      error: `The path "${params.path}" is not visible in the workspace inventory, so its status cannot be read.`,
      ok: false,
    };
  }
  // The inventory deliberately retains fabricated/unvalidated descriptors for
  // visibility (a scanned worktree whose gitdir points somewhere it shouldn't
  // still gets reported so the user can SEE it) — but that means `locate`
  // finding an entry is not proof it is safe to run git in. Mirror
  // `adoptWorktree`'s own trust gate before invoking anything.
  if (located.descriptor.trust === 'unvalidated') {
    return {
      error:
        located.descriptor.trustReason ??
        `The worktree at "${params.path}" could not be verified against its own .git.`,
      ok: false,
    };
  }
  const statusRun = await invokeGitHookFree(
    (args, timeoutMs = GIT_DEFAULT_TIMEOUT_MS) => deps.run({ args, cwd: params.path, timeoutMs }),
    ['status', '--porcelain=v2', '--branch', '-z']
  );
  if (statusRun.exitCode !== 0) {
    return { error: describeFailure(statusRun), ok: false };
  }
  const parsed = parsePorcelainV2Z(statusRun.stdout);
  return {
    ok: true,
    value: {
      ahead: parsed.ahead,
      behind: parsed.behind,
      clean: parsed.clean,
      path: params.path,
      upstream: parsed.upstream,
    },
  };
}

/**
 * The primary checkout is enumerated by `git worktree list` like any other
 * worktree, but it is NOT a worktree-mode target: a thread that operates in
 * the user's own clone is in Local mode. Selecting it would write
 * `checkoutMode: 'worktree'` pointing at the primary, which the hand-off path
 * would then refuse to leave. Stated, never hidden (spec §13).
 */
const PRIMARY_CHECKOUT_GATE: UsabilityGate = {
  disabledReason: "This is the repository's primary checkout — use Hand off to Local instead.",
  remedy: null,
  usable: false,
};

interface UsabilityGate {
  readonly disabledReason: string | null;
  readonly remedy: 'grant-access' | null;
  readonly usable: boolean;
}

export function inventoryListEntry(
  descriptor: WorktreeDescriptor,
  row: ManagedWorktreeRow | null,
  repositoryRoot: string,
  repoCommonDir: string,
  rootIdByPath: ReadonlyMap<string, string>
): WorktreeListEntry {
  const primary = descriptor.path === repositoryRoot;
  const gate = primary ? PRIMARY_CHECKOUT_GATE : resolveUsability(descriptor, row);
  return {
    branch: descriptor.branch,
    containment: descriptor.containment,
    createdAt: row?.createdAt ?? null,
    detached: descriptor.detached,
    disabledReason: gate.disabledReason,
    externalTool: externalToolForPath(descriptor.path),
    id: row?.id ?? null,
    lockedReason: descriptor.lockedReason,
    managed: row !== null,
    name: descriptor.name,
    path: descriptor.path,
    primary,
    // The FIRST producer of anything but 'scanned' (see
    // docs/agents/changeset-diff.md): a scanned worktree that also has a
    // ledger row is known from BOTH sides.
    provenance: row ? 'both' : 'scanned',
    remedy: gate.remedy,
    repoCommonDir,
    repositoryRoot,
    rootId:
      rootIdByPath.get(descriptor.path) ??
      (descriptor.containment === 'outside-roots' ? null : (descriptor.containment[0] ?? null)),
    // (bot review fix, PR #2664 finding 1) `rootId` above keeps its existing
    // "first CONTAINING root" contract — this is the additive, honest signal
    // for whether that root is an EXACT mount of this checkout's own path,
    // never conflated with the containment fallback.
    rootIdIsExactMount: rootIdByPath.get(descriptor.path) !== undefined,
    setupReason: row?.setupReason ?? null,
    setupStatus: row?.setupStatus ?? 'none',
    trust: descriptor.trust,
    trustReason: descriptor.trustReason,
    usable: gate.usable,
  };
}

export function ghostListEntry(
  row: ManagedWorktreeRow,
  rootIdByPath: ReadonlyMap<string, string>
): WorktreeListEntry {
  return {
    branch: row.branch,
    containment: 'outside-roots',
    createdAt: row.createdAt,
    detached: row.branch === null,
    disabledReason: 'Worktree is missing on disk — restore it or archive it.',
    externalTool: externalToolForPath(row.path),
    id: row.id,
    lockedReason: null,
    managed: true,
    name: path.basename(row.path),
    path: row.path,
    primary: false,
    provenance: 'agent-reported',
    remedy: null,
    repoCommonDir: row.repoCommonDir,
    repositoryRoot: repositoryRootFromCommonDir(row.repoCommonDir),
    rootId: rootIdByPath.get(row.path) ?? null,
    // A ghost row's `rootId` is ALREADY exact-match-or-null (no containment
    // fallback exists here — a missing-on-disk row has no live git
    // descriptor to compute containment from), so this is computed the same
    // way, honestly, rather than defaulted to `false`.
    rootIdIsExactMount: rootIdByPath.get(row.path) !== undefined,
    setupReason: row.setupReason,
    setupStatus: row.setupStatus,
    trust: 'unvalidated',
    trustReason: 'missing on disk',
    usable: false,
  };
}

/**
 * Whether this worktree can be USED as a thread's checkout, and if not, why —
 * ordered most-specific-cause first. NO SILENT HIDING and NO SILENT DISABLE:
 * an unusable row is still returned, still carries its reason, and names the
 * remedy when one exists.
 *
 * An in-root worktree with no ledger row is unusable because BrainStrike did
 * not create it, independently of the trust, lock, and prune gates above.
 *
 * `outside-roots` is NOT terminal: a managed worktree is authorized by the
 * ledger, and any other outside-roots worktree becomes usable once the user
 * grants it through the OS picker — which is what `remedy: 'grant-access'`
 * tells the UI to offer (the picker-only ruling in
 * `changes-context-actions.ts` still holds: no caller-supplied path).
 */
function resolveUsability(
  descriptor: WorktreeDescriptor,
  row: ManagedWorktreeRow | null
): UsabilityGate {
  if (descriptor.prunableReason !== null) {
    return {
      disabledReason: `Worktree is prunable: ${descriptor.prunableReason}`,
      remedy: null,
      usable: false,
    };
  }
  if (descriptor.trust === 'unvalidated') {
    return {
      disabledReason:
        descriptor.trustReason ?? 'This worktree could not be verified against its own .git.',
      remedy: null,
      usable: false,
    };
  }
  if (descriptor.lockedReason !== null) {
    return { disabledReason: `Locked: ${descriptor.lockedReason}`, remedy: null, usable: false };
  }
  if (row === null && descriptor.containment !== 'outside-roots') {
    return {
      disabledReason: 'Use Worktrees → Adopt to manage this checkout.',
      remedy: null,
      usable: false,
    };
  }
  // `row !== null` alone is correct here: the branch above already ruled
  // out `row === null && containment !== 'outside-roots'`, so reaching
  // this line with containment !== 'outside-roots' implies row !== null.
  if (row !== null) {
    return { disabledReason: null, remedy: null, usable: true };
  }
  return {
    disabledReason:
      "This worktree isn't inside any workspace folder yet — grant access to use it here.",
    remedy: 'grant-access',
    usable: false,
  };
}

/** Non-bare repositories use `<main-worktree>/.git`; bare common dirs stay as-is. */
function repositoryRootFromCommonDir(repoCommonDir: string): string {
  return path.basename(repoCommonDir) === '.git' ? path.dirname(repoCommonDir) : repoCommonDir;
}
