/** Pure, preload-safe IPC manifests for the visible-UI MCP surface. */
import type {
  McpAppBridge,
  McpAppShellPrepareRequest,
  McpAppShellPrepareResult,
  McpAppShellReleaseRequest,
  McpHostSnapshot,
} from '@brainstrike/assistant-contract';
import type {
  McpContentApplicationError,
  McpContentApplicationRequest,
  McpContentApplicationResult,
} from '@brainstrike/assistant-service/mcp-content-application-port';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Bridge, type Contract, parseNoArgs, rawChannel } from '../platform/ipc-contract';
import { assertArgCount } from './contract-args';

const VISIBLE_UI = ['visible-ui'] as const;

function oneArg<T>(subject: string): (raw: readonly unknown[]) => [value: T] {
  return (raw) => {
    assertArgCount(raw, 1, subject);
    return [raw[0] as T];
  };
}

export interface McpContentIpcFailure {
  readonly category: McpContentApplicationError['category'];
  readonly code: string;
  readonly message: string;
}

export type McpContentIpcResponse =
  | { readonly error: McpContentIpcFailure; readonly ok: false }
  | { readonly ok: true; readonly result: McpContentApplicationResult };

/**
 * Preload-internal: an MCP App resource read names its server's live
 * generation from Main's status mirror. Renderers read status and run
 * lifecycle control on the agent host (`mcp/status/read`, `mcp/server/control`,
 * BST-1930 c5b); this read goes when App content moves to the host (c5d).
 */
export const mcpContract = {
  getServerStatusSnapshot: rawChannel<[], McpHostSnapshot>({
    channel: DESKTOP_IPC_CHANNELS.mcp.statusGet,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
} as const satisfies Contract;

/** Main's native picker: the chosen file becomes the host's selected MCP config. */
export const mcpPathSelectionContract = {
  selectPath: rawChannel<[], string | null>({
    channel: DESKTOP_IPC_CHANNELS.mcp.configSelectPath,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
} as const satisfies Contract;

export const mcpContentContract = {
  complete: rawChannel<[request: unknown], McpContentIpcResponse>({
    channel: DESKTOP_IPC_CHANNELS.mcp.contentComplete,
    parseArgs: oneArg('MCP content completion'),
    roles: VISIBLE_UI,
  }),
  getPrompt: rawChannel<[request: unknown], McpContentIpcResponse>({
    channel: DESKTOP_IPC_CHANNELS.mcp.contentGetPrompt,
    parseArgs: oneArg('MCP prompt read'),
    roles: VISIBLE_UI,
  }),
  readResource: rawChannel<[request: unknown], McpContentIpcResponse>({
    channel: DESKTOP_IPC_CHANNELS.mcp.contentReadResource,
    parseArgs: oneArg('MCP resource read'),
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
export type McpContentContractBridge = Bridge<typeof mcpContentContract>;
export type McpAppsContractBridge = Bridge<typeof mcpAppsContract>;

type McpContentRequest<Type extends McpContentApplicationRequest['type']> = Omit<
  Extract<McpContentApplicationRequest, { type: Type }>,
  'type'
>;
type McpContentResult<Type extends McpContentApplicationResult['type']> = Extract<
  McpContentApplicationResult,
  { type: Type }
>;

/** Renderer-facing MCP shape after the preload's intentional compositions. */
export type McpBridge = McpPathSelectionContractBridge & {
  readonly apps?: McpAppsContractBridge & Pick<McpAppBridge, 'readResource'>;
  readonly complete: (
    request: McpContentRequest<'completion/complete'>
  ) => Promise<McpContentResult<'completion/complete'>>;
  readonly getPrompt: (
    request: McpContentRequest<'prompts/get'>
  ) => Promise<McpContentResult<'prompts/get'>>;
  readonly readResource: (
    request: McpContentRequest<'resources/read'>
  ) => Promise<McpContentResult<'resources/read'>>;
};
