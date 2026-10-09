/** Pure, preload-safe IPC manifests for the visible-UI MCP surface. */
import type {
  McpAppBridge,
  McpAppExecuteRequest,
  McpAppExecuteResult,
  McpAppPrepareRequest,
  McpAppPrepareResult,
  McpAppReleaseRequest,
  McpAppShellPrepareRequest,
  McpAppShellPrepareResult,
  McpAppShellReleaseRequest,
  McpElicitationPresentationWire,
  McpElicitationRetiredWire,
  McpElicitationSettlement,
  McpHostControlRequest,
  McpHostServerSnapshot,
  McpHostSnapshot,
  McpHostWatchEvent,
  McpTaskActionRequest,
  McpTaskActionResult,
  McpTaskListResult,
  McpTaskStatusChangedEvent,
} from '@brainstrike/assistant-contract';
import type {
  McpContentApplicationError,
  McpContentApplicationRequest,
  McpContentApplicationResult,
} from '@brainstrike/assistant-service/mcp-content-application-port';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type Bridge,
  type Contract,
  parseNoArgs,
  pushEvent,
  rawChannel,
} from '../platform/ipc-contract';
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

/** Status and lifecycle control; the host owns MCP settings (`mcp/config/*` and `mcp/tools/*`). */
export const mcpContract = {
  controlServer: rawChannel<[request: McpHostControlRequest], McpHostServerSnapshot>({
    channel: DESKTOP_IPC_CHANNELS.mcp.lifecycleControl,
    parseArgs: oneArg('MCP lifecycle control'),
    roles: VISIBLE_UI,
  }),
  getServerStatusSnapshot: rawChannel<[], McpHostSnapshot>({
    channel: DESKTOP_IPC_CHANNELS.mcp.statusGet,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
  onServerStatusUpdated: pushEvent<McpHostWatchEvent>({
    channel: DESKTOP_IPC_CHANNELS.mcp.statusUpdated,
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

export const mcpElicitationContract = {
  onElicitationRequested: pushEvent<McpElicitationPresentationWire>({
    channel: DESKTOP_IPC_CHANNELS.mcp.elicitationRequested,
  }),
  onElicitationRetired: pushEvent<McpElicitationRetiredWire>({
    channel: DESKTOP_IPC_CHANNELS.mcp.elicitationRetired,
  }),
  settleElicitation: rawChannel<[settlement: McpElicitationSettlement], void>({
    channel: DESKTOP_IPC_CHANNELS.mcp.elicitationSettle,
    parseArgs: oneArg('MCP elicitation settlement'),
    roles: VISIBLE_UI,
  }),
} as const satisfies Contract;

export const mcpAppsContract = {
  execute: rawChannel<[request: McpAppExecuteRequest], McpAppExecuteResult>({
    channel: DESKTOP_IPC_CHANNELS.mcp.appsExecute,
    parseArgs: oneArg('MCP App execute'),
    roles: VISIBLE_UI,
  }),
  prepare: rawChannel<[request: McpAppPrepareRequest], McpAppPrepareResult>({
    channel: DESKTOP_IPC_CHANNELS.mcp.appsPrepare,
    parseArgs: oneArg('MCP App prepare'),
    roles: VISIBLE_UI,
  }),
  prepareShell: rawChannel<[request: McpAppShellPrepareRequest], McpAppShellPrepareResult>({
    channel: DESKTOP_IPC_CHANNELS.mcp.appsPrepareShell,
    parseArgs: oneArg('MCP App shell prepare'),
    roles: VISIBLE_UI,
  }),
  release: rawChannel<[request: McpAppReleaseRequest], void>({
    channel: DESKTOP_IPC_CHANNELS.mcp.appsRelease,
    parseArgs: oneArg('MCP App release'),
    roles: VISIBLE_UI,
  }),
  releaseShell: rawChannel<[request: McpAppShellReleaseRequest], void>({
    channel: DESKTOP_IPC_CHANNELS.mcp.appsReleaseShell,
    parseArgs: oneArg('MCP App shell release'),
    roles: VISIBLE_UI,
  }),
} as const satisfies Contract;

export const mcpTasksContract = {
  act: rawChannel<[request: McpTaskActionRequest], McpTaskActionResult>({
    channel: DESKTOP_IPC_CHANNELS.mcp.taskAct,
    parseArgs: oneArg('MCP task action'),
    roles: VISIBLE_UI,
  }),
  list: rawChannel<[], McpTaskListResult>({
    channel: DESKTOP_IPC_CHANNELS.mcp.taskList,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
  onStatusChanged: pushEvent<McpTaskStatusChangedEvent>({
    channel: DESKTOP_IPC_CHANNELS.mcp.taskStatusChanged,
  }),
} as const satisfies Contract;

export type McpContractBridge = Bridge<typeof mcpContract>;
export type McpPathSelectionContractBridge = Bridge<typeof mcpPathSelectionContract>;
export type McpContentContractBridge = Bridge<typeof mcpContentContract>;
export type McpElicitationContractBridge = Bridge<typeof mcpElicitationContract>;
export type McpAppsContractBridge = Bridge<typeof mcpAppsContract>;
export type McpTasksContractBridge = Bridge<typeof mcpTasksContract>;

type McpContentRequest<Type extends McpContentApplicationRequest['type']> = Omit<
  Extract<McpContentApplicationRequest, { type: Type }>,
  'type'
>;
type McpContentResult<Type extends McpContentApplicationResult['type']> = Extract<
  McpContentApplicationResult,
  { type: Type }
>;

/** Renderer-facing MCP shape after the preload's intentional compositions. */
export type McpBridge = McpContractBridge &
  McpPathSelectionContractBridge &
  McpElicitationContractBridge & {
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
    readonly tasks?: McpTasksContractBridge;
  };
