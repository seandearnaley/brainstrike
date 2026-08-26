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
  readonly resolveInventory: () => Promise<GitInventory>;
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
  if (descriptor.containment !== 'outside-roots') {
    return { ok: true, value: null };
  }
  const settings = await deps.readSettings();
  try {
    const managed = await fsPromises.realpath(settings.managedDirectory);
    if (isWithin(managed, descriptor.path)) {
      return { ok: true, value: null };
    }
  } catch (error) {
    logger.debug('managed directory could not be resolved during adoption', { error });
  }
  return {
    error: `The worktree at "${descriptor.path}" is outside every open folder. Grant access to its folder first, then adopt it.`,
    ok: false,
  };
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

export interface WorktreeShellReconcileResult {
  readonly adopted: readonly ManagedWorktreeRow[];
  /**
   * Live ledger rows whose directory is no longer on disk. Reported, NOT
   * archived: an archive carries a restorable snapshot, and a `git worktree
   * remove` run in a shell produced none. `list()` already renders these as
   * ghost rows reading "missing on disk — restore it or archive it", which is
   * the honest surface for a removal the app did not perform.
   */
  readonly vanishedLedgerIds: readonly string[];
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
  const inventory = await deps.resolveInventory();
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
  const vanishedLedgerIds = activeRows
    .filter((row) => row.repoCommonDir === params.repoCommonDir && !onDiskPaths.has(row.path))
    .map((row) => row.id);

  const adopted: ManagedWorktreeRow[] = [];
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
  } else {
    for (const descriptor of repository.worktrees) {
      // The primary checkout is not a managed worktree; adopting it would put
      // the user's own clone under archive/restore machinery.
      if (descriptor.path === repository.identity.repositoryRoot) {
        continue;
      }
      if (params.precedingWorktreePaths.has(descriptor.path)) {
        // Existed BEFORE this command ran — not this run's doing, whatever it
        // is. Never attribute it here, even if it is genuinely unmanaged.
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
  }
  return { ok: true, value: { adopted, vanishedLedgerIds } };
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
      disabledReason: 'Created outside BrainStrike — adopting it is coming with the Worktree Map.',
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
