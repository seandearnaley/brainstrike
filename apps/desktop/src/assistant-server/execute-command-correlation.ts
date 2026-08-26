/**
 * Wraps `runExecuteCommand` with the shell-output correlator's mis-attribution
 * guard (BST-1392, spec §6.4; review round finding). Extracted from
 * `assistant-tools.ts` — that file sits at the 1000-line Biome ceiling, the
 * same reason `worktree-tools.ts` was split out in Task 10.
 *
 * The guard: snapshot on-disk worktree paths BEFORE the command runs, but
 * ONLY when its text looks worktree-shaped (a false positive here costs one
 * cheap, cached-inventory `list()` call, never a git spawn and never a
 * blocked command). Without this snapshot, a scanner false positive
 * (quote-blindness on a heredoc or quoted string) combined with a reconcile
 * that otherwise adopts every unmanaged worktree would durably attribute a
 * user's own pre-existing external checkout (Claude Code, Codex, ...) to
 * this run — the exact population this feature exists to serve honestly.
 * `undefined` (no snapshot) is a distinct, honest signal from an empty set:
 * the reconciler treats it as "cannot safely attribute anything new" and
 * adopts nothing, per `reconcileWorktreesFromShell`'s own fail-closed rule.
 */
import type { ExecuteCommandInput, RuntimeData } from '@brainstrike/agent';
import { scanShellCommandForGitSignals } from '@brainstrike/assistant-contract';
import type { ExecuteCommandToolResult, ShellOutputStreamer } from './execute-command-tool';
import { runExecuteCommand } from './execute-command-tool';
import type { ShellCorrelationCapability } from './shell-worktree-correlation';
import type { WorktreeToolCapability } from './worktree-tools';

async function snapshotWorktreePaths(
  worktreeTools: WorktreeToolCapability | undefined
): Promise<ReadonlySet<string> | undefined> {
  if (!worktreeTools) {
    return undefined;
  }
  const listed = await worktreeTools.list();
  return listed.ok ? new Set(listed.value.map((entry) => entry.path)) : undefined;
}

export async function runExecuteCommandWithShellCorrelation(
  input: ExecuteCommandInput,
  runtimeData: RuntimeData | undefined,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly stream?: ShellOutputStreamer | undefined;
  },
  dependencies: {
    readonly shellCorrelation?: ShellCorrelationCapability | undefined;
    readonly worktreeTools?: WorktreeToolCapability | undefined;
  }
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
