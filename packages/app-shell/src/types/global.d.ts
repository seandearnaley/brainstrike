import type {
  AssistantCheckpointRevertResult,
  AssistantCheckpointRevertRunResult,
  UserSlashCommandsListResult,
} from '@brainstrike/assistant-contract';
import type {
  AssistantSelectionUpdatePayload,
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
} from '@brainstrike/types';

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
      revertEntry?: (
        id: string,
        options?: { force?: boolean }
      ) => Promise<AssistantCheckpointRevertResult>;
      revertRun?: (
        runId: string,
        options?: { force?: boolean }
      ) => Promise<AssistantCheckpointRevertRunResult>;
    };
    mcp?: {
      getConfig?: () => Promise<
        | {
            error?: string;
            path: string;
            exists: boolean;
            servers?: Array<{
              name: string;
              transport: 'sse' | 'stdio' | 'streamable-http';
            }>;
          }
        | undefined
      >;
      onConfigUpdated?: (
        callback: (config: {
          error?: string;
          path: string;
          exists: boolean;
          servers?: Array<{
            name: string;
            transport: 'sse' | 'stdio' | 'streamable-http';
          }>;
        }) => void
      ) => (() => void) | undefined;
      watch?: () => Promise<{ watching: boolean }>;
      unwatch?: () => Promise<{ watching: false }>;
      listTools?: () => Promise<
        Record<
          string,
          Array<{
            id: string;
            serverName?: string;
            description?: string;
            inputSchema?: unknown;
            enabled: boolean;
            discoveredAt?: number;
          }>
        >
      >;
      enableTools?: (toolIds: string[]) => Promise<void>;
      disableTools?: (toolIds: string[]) => Promise<void>;
      onToolsUpdated?: (
        callback: (
          tools: Record<
            string,
            Array<{
              id: string;
              serverName?: string;
              description?: string;
              inputSchema?: unknown;
              enabled: boolean;
              discoveredAt?: number;
            }>
          >
        ) => void
      ) => (() => void) | undefined;
    };
    tools?: {
      execute?: (
        toolId: string,
        input: unknown,
        runtimeData?: Record<string, unknown>
      ) => Promise<{
        success: boolean;
        result?: unknown;
        error?: string;
        durationMs: number;
      }>;
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
     * (no preload) — capability-check `window.userCommands` rather than
     * `isElectron()`.
     */
    userCommands?: {
      list?: () => Promise<UserSlashCommandsListResult>;
    };
  }
}
