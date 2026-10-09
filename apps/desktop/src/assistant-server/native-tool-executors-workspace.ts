/**
 * Executor entries for the workspace context write-back and worktree tools
 * (BST-1646 step c), over Main's own window delivery and worktree service;
 * `native-tool-executors.ts` assembles the exhaustive map with the shared
 * host-capabilities executors.
 */

import { type DesktopToolBuildContext, executorGroup } from './native-tool-executor-context';
import { contextWriteExecutors } from './native-tool-executors-context';
import { worktreeToolExecutors } from './native-tool-executors-worktree';
import { mainWorkspaceContextBroadcaster } from './workspace-context-broadcast';

export const WORKSPACE_TOOL_EXECUTORS = executorGroup({
  ...contextWriteExecutors(mainWorkspaceContextBroadcaster),
  // Main passes its own worktree service for a legacy thread.
  ...worktreeToolExecutors(
    ({ dependencies }: DesktopToolBuildContext) => dependencies.worktreeTools
  ),
});
