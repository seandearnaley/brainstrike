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
  McpExtensionEnablement,
  McpHostControlRequest,
  McpHostServerSnapshot,
  McpHostSnapshot,
  McpHostWatchEvent,
  McpTaskActionRequest,
  McpTaskActionResult,
  McpTaskListResult,
  McpTaskStatusChangedEvent,
  McpToolPreferencesFault,
} from '@brainstrike/assistant-contract';
import type {
  McpProtocolMigration,
  ResolvedMcpServer,
} from '@brainstrike/assistant-contract/mcp-config';
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

function oneString(subject: string): (raw: readonly unknown[]) => [value: string] {
  return (raw) => {
    assertArgCount(raw, 1, subject);
    if (typeof raw[0] !== 'string') {
      throw new Error(`${subject} requires a string`);
    }
    return [raw[0]];
  };
}

function oneStringArray(subject: string): (raw: readonly unknown[]) => [value: string[]] {
  return (raw) => {
    assertArgCount(raw, 1, subject);
    if (!Array.isArray(raw[0]) || raw[0].some((value) => typeof value !== 'string')) {
      throw new Error(`${subject} requires an array of strings`);
    }
    return [[...raw[0]]];
  };
}

export interface McpToolProjection {
  readonly description?: string;
  readonly discoveredAt: number;
  readonly enabled: boolean;
  readonly id: string;
  readonly inputSchema?: unknown;
  readonly serverName: string;
}

export interface McpConfigStatus {
  error?: string;
  exists: boolean;
  loadedAt?: number;
  migrations?: McpProtocolMigration[];
  path: string;
  servers?: Array<{
    name: string;
    protocol: ResolvedMcpServer['protocol'];
    transport: ResolvedMcpServer['transport'];
  }>;
}

export interface McpContentIpcFailure {
  readonly category: McpContentApplicationError['category'];
  readonly code: string;
  readonly message: string;
}

export type McpContentIpcResponse =
  | { readonly error: McpContentIpcFailure; readonly ok: false }
  | { readonly ok: true; readonly result: McpContentApplicationResult };

export interface McpToolStatsProjection {
  readonly disabled: number;
  readonly enabled: number;
  readonly preferencesFault?: McpToolPreferencesFault;
  readonly servers: number;
  readonly total: number;
}

export const mcpContract = {
  controlServer: rawChannel<[request: McpHostControlRequest], McpHostServerSnapshot>({
    channel: DESKTOP_IPC_CHANNELS.mcp.lifecycleControl,
    parseArgs: oneArg('MCP lifecycle control'),
    roles: VISIBLE_UI,
  }),
  createSampleConfig: rawChannel<[], { success: boolean; path: string; error?: string }>({
    channel: DESKTOP_IPC_CHANNELS.mcp.configCreateSample,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
  disableServerTools: rawChannel<[serverName: string], void>({
    channel: DESKTOP_IPC_CHANNELS.mcp.toolsDisableServer,
    parseArgs: oneString('MCP disable server tools'),
    roles: VISIBLE_UI,
  }),
  disableTools: rawChannel<[toolIds: string[]], void>({
    channel: DESKTOP_IPC_CHANNELS.mcp.toolsDisable,
    parseArgs: oneStringArray('MCP disable tools'),
    roles: VISIBLE_UI,
  }),
  enableServerTools: rawChannel<[serverName: string], void>({
    channel: DESKTOP_IPC_CHANNELS.mcp.toolsEnableServer,
    parseArgs: oneString('MCP enable server tools'),
    roles: VISIBLE_UI,
  }),
  enableTools: rawChannel<[toolIds: string[]], void>({
    channel: DESKTOP_IPC_CHANNELS.mcp.toolsEnable,
    parseArgs: oneStringArray('MCP enable tools'),
    roles: VISIBLE_UI,
  }),
  getConfig: rawChannel<[], McpConfigStatus>({
    channel: DESKTOP_IPC_CHANNELS.mcp.configGet,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
  getExtensionPreferences: rawChannel<[], McpExtensionEnablement>({
    channel: DESKTOP_IPC_CHANNELS.mcp.extensionsGet,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
  getPath: rawChannel<[], string>({
    channel: DESKTOP_IPC_CHANNELS.mcp.configGetPath,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
  getServerStatusSnapshot: rawChannel<[], McpHostSnapshot>({
    channel: DESKTOP_IPC_CHANNELS.mcp.statusGet,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
  getToolStats: rawChannel<[], McpToolStatsProjection>({
    channel: DESKTOP_IPC_CHANNELS.mcp.toolsGetStats,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
  listTools: rawChannel<[], Record<string, McpToolProjection[]>>({
    channel: DESKTOP_IPC_CHANNELS.mcp.toolsList,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
  onConfigUpdated: pushEvent<McpConfigStatus>({
    channel: DESKTOP_IPC_CHANNELS.mcp.configUpdated,
  }),
  onExtensionPreferencesUpdated: pushEvent<McpExtensionEnablement>({
    channel: DESKTOP_IPC_CHANNELS.mcp.extensionsUpdated,
  }),
  onServerStatusUpdated: pushEvent<McpHostWatchEvent>({
    channel: DESKTOP_IPC_CHANNELS.mcp.statusUpdated,
  }),
  onToolsUpdated: pushEvent<Record<string, McpToolProjection[]>>({
    channel: DESKTOP_IPC_CHANNELS.mcp.toolsUpdated,
  }),
  readConfigText: rawChannel<
    [],
    { path: string; exists: boolean; created: boolean; content: string }
  >({
    channel: DESKTOP_IPC_CHANNELS.mcp.configReadText,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
  resetTools: rawChannel<[], void>({
    channel: DESKTOP_IPC_CHANNELS.mcp.toolsReset,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
  setExtensionPreferences: rawChannel<[preferences: unknown], McpExtensionEnablement>({
    channel: DESKTOP_IPC_CHANNELS.mcp.extensionsSet,
    parseArgs: oneArg('MCP extension preferences'),
    roles: VISIBLE_UI,
  }),
  setPath: rawChannel<[configPath: string | null], { success: boolean; path: string }>({
    channel: DESKTOP_IPC_CHANNELS.mcp.configSetPath,
    parseArgs: (raw) => {
      assertArgCount(raw, 1, 'MCP config path');
      if (raw[0] !== null && typeof raw[0] !== 'string') {
        throw new Error('MCP config path requires a string or null');
      }
      return [raw[0]];
    },
    roles: VISIBLE_UI,
  }),
  unwatch: rawChannel<[], { watching: false }>({
    channel: DESKTOP_IPC_CHANNELS.mcp.configUnwatch,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
  watch: rawChannel<[], { watching: boolean }>({
    channel: DESKTOP_IPC_CHANNELS.mcp.configWatch,
    parseArgs: parseNoArgs,
    roles: VISIBLE_UI,
  }),
  writeConfigText: rawChannel<
    [content: unknown],
    { success: true; path: string } | { success: false; path: string; error: string }
  >({
    channel: DESKTOP_IPC_CHANNELS.mcp.configWriteText,
    // The handler intentionally returns its established failure envelope for
    // non-string content; preserve that public behavior instead of rejecting here.
    parseArgs: oneArg('MCP config text'),
    roles: VISIBLE_UI,
  }),
} as const satisfies Contract;

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
