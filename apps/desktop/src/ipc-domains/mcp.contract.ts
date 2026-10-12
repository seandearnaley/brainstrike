/** Pure, preload-safe IPC manifests for the visible-UI MCP surface. */
import type {
  McpAppShellPrepareRequest,
  McpAppShellPrepareResult,
  McpAppShellReleaseRequest,
} from '@brainstrike/assistant-contract';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Bridge, type Contract, parseNoArgs, rawChannel } from '../platform/ipc-contract';
import { assertArgCount } from './contract-args';

/**
 * Main's remaining MCP channels (BST-1930 c5d): the native config picker and
 * the MCP App shell. Settings, status, control, Tasks cards, server input and
 * content are agent-host methods.
 */
const VISIBLE_UI = ['visible-ui'] as const;

function oneArg<T>(subject: string): (raw: readonly unknown[]) => [value: T] {
  return (raw) => {
    assertArgCount(raw, 1, subject);
    return [raw[0] as T];
  };
}

/** Main's native picker: the chosen file becomes the host's selected MCP config. */
export const mcpPathSelectionContract = {
  selectPath: rawChannel<[], string | null>({
    channel: DESKTOP_IPC_CHANNELS.mcp.configSelectPath,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
} as const satisfies Contract;

export const mcpAppsContract = {
  prepareShell: rawChannel<[request: McpAppShellPrepareRequest], McpAppShellPrepareResult>({
    channel: DESKTOP_IPC_CHANNELS.mcp.appsPrepareShell,
    parseArgs: oneArg('MCP App shell prepare'),
    roles: VISIBLE_UI,
  }),
  releaseShell: rawChannel<[request: McpAppShellReleaseRequest], void>({
    channel: DESKTOP_IPC_CHANNELS.mcp.appsReleaseShell,
    parseArgs: oneArg('MCP App shell release'),
    roles: VISIBLE_UI,
  }),
} as const satisfies Contract;

export type McpPathSelectionContractBridge = Bridge<typeof mcpPathSelectionContract>;
export type McpAppsContractBridge = Bridge<typeof mcpAppsContract>;

/** The renderer-facing `window.mcp`: the config picker and the MCP App shell. */
export type McpBridge = McpPathSelectionContractBridge & {
  readonly apps?: McpAppsContractBridge;
};
