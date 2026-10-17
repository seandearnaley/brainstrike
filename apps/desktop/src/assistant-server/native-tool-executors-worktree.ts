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

/**
 * BST-1392. Both worktree ids are `localProvider: 'unregistered'` in the
 * catalog, so every fold skips them for the built-in local provider.
 */
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
      buildWorktreeMastraTools(context.runtimeData, capability(context))[
        NATIVE_TOOL_ID.manageWorktree
      ],
  };
}
