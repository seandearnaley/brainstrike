/**
 * Wraps `runExecuteCommand` with the shell-output correlator's mis-attribution
 * guard (BST-1392, spec §6.4; review round finding). Extracted from
 * `assistant-tools.ts` — that file sits at the 1000-line Biome ceiling, the
 * same reason `worktree-tools.ts` was split out in Task 10.
 *
 * The guard: snapshot on-disk worktree paths BEFORE the command runs, but
 * ONLY when its text looks worktree-shaped. This is NOT always a cheap call:
 * `list()` reads the inventory service's TTL-cached snapshot
 * (`git-inventory-service.ts`), which is cheap on a hit, but a stale-or-dirty
 * cache rebuilds by spawning git across every repository in the workspace —
 * and this call is awaited pre-command, on the critical path of every
 * worktree-shaped `executeCommand`. The bound is scope, not cost: it only
 * ever runs for commands the scanner judges worktree-shaped, never for the
 * general case. Without this snapshot, a scanner false positive
 * (quote-blindness on a heredoc or quoted string) combined with a reconcile
 * that otherwise adopts every unmanaged worktree would durably attribute a
 * user's own pre-existing external checkout (Claude Code, Codex, ...) to
 * this run — the exact population this feature exists to serve honestly.
 * `undefined` (no snapshot) is a distinct, honest signal from an empty set:
 * the reconciler treats it as "cannot safely attribute anything new" and
 * adopts nothing, per `reconcileWorktreesFromShell`'s own fail-closed rule.
 * A snapshot failure (see `snapshotWorktreePaths`) degrades to that same
 * `undefined` signal rather than blocking the command.
 *
 * Known limitation (best-effort, not fixed here): a command run from a cwd
 * belonging to a DIFFERENT repository than the one the reconciler resolves
 * from the tool result's `rootId` degrades to an empty delta — a missed
 * breadcrumb, not a wrong one, and within this feature's stated best-effort
 * contract.
 */
import type { ExecuteCommandInput, RuntimeData } from '@brainstrike/agent';
import { scanShellCommandForGitSignals } from '@brainstrike/assistant-contract';
import type { ShellOutputStreamer } from '@brainstrike/host-capabilities/native-tools';
import { createLogger } from '@brainstrike/logging';
import type { GitResult } from '@brainstrike/types';
import type { ExecuteCommandToolResult } from './execute-command-tool';
import { runExecuteCommand } from './execute-command-tool';
import type { ShellCorrelationCapability } from './shell-worktree-correlation';

const logger = createLogger('ExecuteCommandCorrelation');

/** The worktree listing the pre-command snapshot reads; only paths are needed. */
export interface WorktreePathListing {
  readonly list: () => Promise<GitResult<readonly { readonly path: string }[]>>;
}

/** Where a command's worktree/forge side effects are correlated (BST-1392). */
export interface ShellCorrelationDependencies {
  readonly shellCorrelation?: ShellCorrelationCapability | undefined;
  readonly worktreeTools?: WorktreePathListing | undefined;
}

async function snapshotWorktreePaths(
  worktreeTools: WorktreePathListing | undefined
): Promise<ReadonlySet<string> | undefined> {
  if (!worktreeTools) {
    return undefined;
  }
  try {
    const listed = await worktreeTools.list();
    return listed.ok ? new Set(listed.value.map((entry) => entry.path)) : undefined;
  } catch (error) {
    // A breadcrumb must never block the command it describes. The reconcile
    // pass already fails closed to "adopt nothing" on an `undefined`
    // snapshot, so a snapshot failure degrades to that same safe state
    // instead of throwing out of a pre-command await.
    logger.error('pre-command worktree snapshot failed', { error });
    return undefined;
  }
}

export async function runExecuteCommandWithShellCorrelation(
  input: ExecuteCommandInput,
  runtimeData: RuntimeData | undefined,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly stream?: ShellOutputStreamer | undefined;
  },
  dependencies: ShellCorrelationDependencies
): Promise<ExecuteCommandToolResult> {
  const precedingWorktreePaths =
    dependencies.shellCorrelation && scanShellCommandForGitSignals(input.command).touchedWorktrees
      ? await snapshotWorktreePaths(dependencies.worktreeTools)
      : undefined;
  const result = await runExecuteCommand(input, runtimeData, options);
  // Fire-and-forget: the correlator never awaits, never throws into the tool
  // call, and reads only the MODEL-SUPPLIED command plus the result's own
  // resolved rootId.
  dependencies.shellCorrelation?.onCommandCompleted({
    command: input.command,
    precedingWorktreePaths,
    rootId: result.rootId,
  });
  return result;
}
