/** Pure, preload-safe IPC manifests for the visible-UI MCP surface. */
import type {
  McpAppShellPrepareRequest,
  McpAppShellPrepareResult,
  McpAppShellReleaseRequest,
} from '@brainstrike/assistant-contract';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Bridge, type Contract, rawChannel } from '../platform/ipc-contract';

/** Main's native picker: the chosen file becomes the host's selected MCP config. */
export const mcpPathSelectionContract = {
  selectPath: rawChannel<[], string | null>({
    channel: DESKTOP_IPC_CHANNELS.mcp.configSelectPath,
  }),
} as const satisfies Contract;

export const mcpAppsContract = {
  prepareShell: rawChannel<[request: McpAppShellPrepareRequest], McpAppShellPrepareResult>({
    channel: DESKTOP_IPC_CHANNELS.mcp.appsPrepareShell,
  }),
  releaseShell: rawChannel<[request: McpAppShellReleaseRequest], void>({
    channel: DESKTOP_IPC_CHANNELS.mcp.appsReleaseShell,
  }),
} as const satisfies Contract;

export type McpPathSelectionContractBridge = Bridge<typeof mcpPathSelectionContract>;
export type McpAppsContractBridge = Bridge<typeof mcpAppsContract>;

/** The renderer-facing `window.mcp`: the config picker and the MCP App shell. */
export type McpBridge = McpPathSelectionContractBridge & {
  readonly apps?: McpAppsContractBridge;
};
