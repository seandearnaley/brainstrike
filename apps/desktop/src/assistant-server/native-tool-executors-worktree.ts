/**
 * listWorktrees and manageWorktree over a caller-supplied worktree capability:
 * the desktop agent host passes Main's narrow worktree calls until the
 * worktree ledger is a host fact. This module
 * must not import Electron: the host bundle loads it.
 */
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type {
  NativeToolBuildContext,
  NativeToolDefinition,
} from '@brainstrike/host-capabilities/native-tools';
import { buildWorktreeMastraTools, type WorktreeToolCapability } from './worktree-tools';

/** The worktree tools (BST-1392), built only when Main lends its worktree capability. */
export function worktreeToolExecutors<Context extends NativeToolBuildContext>(
  capability: (context: Context) => WorktreeToolCapability | undefined
): {
  readonly [NATIVE_TOOL_ID.listWorktrees]: (context: Context) => NativeToolDefinition | undefined;
  readonly [NATIVE_TOOL_ID.manageWorktree]: (context: Context) => NativeToolDefinition | undefined;
} {
  return {
    [NATIVE_TOOL_ID.listWorktrees]: (context) =>
      buildWorktreeMastraTools(context.runtimeData, capability(context))[
        NATIVE_TOOL_ID.listWorktrees
      ],
    [NATIVE_TOOL_ID.manageWorktree]: (context) =>
      buildWorktreeMastraTools(
        context.runtimeData,
        capability(context),
        context.ports.enterWorktree
      )[NATIVE_TOOL_ID.manageWorktree],
  };
}
