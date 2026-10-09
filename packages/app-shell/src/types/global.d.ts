import type {
  AssistantCheckpointRevertResult,
  AssistantCheckpointRevertRunResult,
  AssistantCheckpointUndoAvailabilityMap,
} from '@brainstrike/assistant-contract';
import type { SkillsBridge } from '@brainstrike/assistant-contract/skills-bridge';
import type {
  AssistantSelectionUpdatePayload,
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
} from '@brainstrike/types';
import type { ChangesBridge } from '../changes/changes-bridge';
import type { McpPromptBridge } from '../mcp-prompts/mcp-prompt-bridge';
import type { PlatformBridge } from '../platform-bridge';
import type { UserCommandsBridge } from '../user-commands-bridge';
import type { WorktreesBridge } from '../worktrees/worktrees-bridge';

declare global {
  interface Window {
    agent?: {
      chat?: (messages: unknown[], runtime?: unknown) => Promise<unknown[]>;
    };
    /**
     * Edit checkpoint (undo of agent file edits) revert bridge. Desktop only —
     * web never defines it (no assistant server / main process). Invoke-only.
     */
    assistantCheckpoints?: {
      availability?: (threadId: string) => Promise<AssistantCheckpointUndoAvailabilityMap>;
      revertEntry?: (
        id: string,
        options?: { force?: boolean }
      ) => Promise<AssistantCheckpointRevertResult>;
      revertRun?: (
        runId: string,
        options?: { force?: boolean }
      ) => Promise<AssistantCheckpointRevertRunResult>;
    };
    /**
     * Desktop-only changeset diff bridge (BST-1113/BST-1114). Absent on web
     * (no preload) — capability-check via `resolveChangesBridge()`
     * (`changes-bridge.ts`) rather than `isElectron()`. Derived from
     * `ChangesBridge` so this declaration cannot drift from the interface;
     * `Partial` because a present-but-incomplete bridge is possible until the
     * resolver validates it.
     */
    changes?: Partial<ChangesBridge>;
    /**
     * Desktop-only MCP content bridge. The composer's MCP prompt affordance
     * (BST-1592) uses its `McpPromptBridge` content members, capability-checked
     * via `resolveMcpPromptBridge()` rather than `isElectron()`; the agent host
     * owns MCP settings and status (BST-1930 c5a-c5b).
     */
    mcp?: Partial<Pick<McpPromptBridge, 'complete' | 'getPrompt'>>;
    /**
     * Desktop-only OS shell integration bridge. Absent on web (no preload) —
     * capability-check via `resolvePlatformBridge()` (`platform-bridge.ts`)
     * rather than `isElectron()`. Derived from `PlatformBridge` so this
     * declaration cannot drift from the interface; `Partial` because a
     * present-but-incomplete bridge is possible until the resolver validates
     * it.
     */
    platform?: Partial<PlatformBridge>;
    /**
     * Desktop-only Agent Skills discovery bridge. Absent on web (no preload) —
     * capability-check via `resolveSkillsBridge()`
     * (`@brainstrike/assistant-contract/skills-bridge` — shared with
     * settings-ui, which cannot import app-shell) rather than `isElectron()`.
     * Derived from `SkillsBridge` so this declaration
     * cannot drift from the interface; `Partial` because a
     * present-but-incomplete bridge is possible until the resolver validates
     * it.
     */
    skills?: Partial<SkillsBridge>;
    tools?: {
      onRootTreeSelectionUpdate?: (
        callback: (payload: AssistantSelectionUpdatePayload) => void
      ) => (() => void) | undefined;
      onPreviewContextSelectionUpdate?: (
        callback: (payload: AssistantSelectionUpdatePayload) => void
      ) => (() => void) | undefined;
      onWorkspaceContextSelectionUpdate?: (
        callback: (payload: AssistantWorkspaceContextSelectionUpdatePayload) => void
      ) => (() => void) | undefined;
      onWorkspaceContextTapestryUpdate?: (
        callback: (payload: AssistantWorkspaceTapestryUpdatePayload) => void
      ) => (() => void) | undefined;
    };
    /**
     * Desktop-only user-defined slash command discovery bridge. Absent on web
     * (no preload) — capability-check via `resolveUserCommandsBridge()`
     * (`user-commands-bridge.ts`) rather than `isElectron()`. Derived from
     * `UserCommandsBridge` so this declaration cannot drift from the
     * interface; `Partial` because a present-but-incomplete bridge is possible
     * until the resolver validates it.
     */
    userCommands?: Partial<UserCommandsBridge>;
    /**
     * Desktop-only managed-worktree bridge (BST-1390). Absent on web (no
     * preload) — capability-check via `resolveWorktreesBridge()` rather than
     * `isElectron()`. Derived from `WorktreesBridge` so this declaration cannot
     * drift; `Partial` because a present-but-incomplete bridge is possible
     * until the resolver validates it.
     */
    worktrees?: Partial<WorktreesBridge>;
  }
}
