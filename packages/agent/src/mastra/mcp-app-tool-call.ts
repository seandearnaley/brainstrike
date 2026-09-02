import type { ToolRiskCategory } from '@brainstrike/assistant-contract/tool-metadata';
import type { McpAppPreparedToolCall, McpAppToolCall } from '@brainstrike/mcp-app-host';
import type { ToolsInput } from '@mastra/core/agent';
import { isGuardedToolError } from '../tools/guard-tool-execution';
import { readHookResultEnvelope } from '../tools/hook-runner';
import type { ToolLogger } from '../tools/types';
import { retainRawMcpCallToolResult } from './mcp-runtime-client';
import type { PermissionAskToolMetadata } from './permission-tool-gate';

export interface McpAppOrdinaryToolCallOptions {
  readonly admission: McpAppToolAdmissionCapability;
  readonly logger?: ToolLogger;
  readonly onTelemetry?: (event: McpAppToolCallTelemetry) => void;
}

interface McpAppBoundOrdinaryExecutor {
  readonly decision: 'allow' | 'ask';
  readonly execute: (context: Readonly<{ signal: AbortSignal }>) => Promise<unknown>;
  readonly riskCategory: ToolRiskCategory;
}

export interface McpAppInadmissibleTool {
  readonly reason: string;
  readonly toolId: string;
}

export interface McpAppToolAdmissionCapability {
  readonly admit: (
    call: Pick<McpAppToolCall, 'input' | 'serverId' | 'toolName'>
  ) => McpAppBoundOrdinaryExecutor;
  /**
   * Admitted tools whose definition carries the Apps `_meta.ui` marker. A run
   * with none can never mount an app, so the host registers no admission for
   * it (and an app-free later run does not supersede a thread's still-mounted
   * app admission).
   */
  readonly appCapableToolCount: number;
  /**
   * Tools the ordinary runtime holds but Apps cannot call, with the reason.
   * Admission problems are recorded here and refused at `admit` time instead
   * of aborting every agent runtime assembly for a feature that is dormant.
   */
  readonly inadmissibleTools: readonly McpAppInadmissibleTool[];
  /** Exact configured server ids represented by this live runtime's admitted map. */
  readonly serverIds: readonly string[];
}

export interface McpAppToolCallTelemetry {
  readonly durationMs: number;
  readonly outcome: 'cancelled' | 'completed' | 'failed';
  readonly toolName: string;
}

interface ExecutableTool {
  execute: (...args: unknown[]) => unknown;
  mcpMetadata?: unknown;
}

interface CreateMcpAppToolAdmissionCapabilityOptions {
  readonly askTools: ReadonlyMap<string, PermissionAskToolMetadata>;
  readonly defaultRisk?: ToolRiskCategory;
  readonly riskByTool?: Readonly<Record<string, ToolRiskCategory>>;
  readonly toolNameMap: ReadonlyMap<string, string>;
  readonly tools: ToolsInput;
}

export class McpAppToolNotAdmittedError extends Error {
  readonly code = 'mcp_app_tool_not_admitted';

  constructor(toolName: string, reason?: string) {
    super(
      `MCP Apps tool ${toolName} is not admitted by the ordinary runtime${reason === undefined ? '' : `: ${reason}`}`
    );
    this.name = 'McpAppToolNotAdmittedError';
  }
}

export class McpAppToolExecutorConsumedError extends Error {
  readonly code = 'mcp_app_tool_executor_consumed';

  constructor(toolName: string) {
    super(`MCP Apps ordinary executor for ${toolName} has already been consumed`);
    this.name = 'McpAppToolExecutorConsumedError';
  }
}

function isExecutableTool(tool: unknown): tool is ExecutableTool {
  return typeof (tool as { execute?: unknown } | undefined)?.execute === 'function';
}

function isMcpCallToolErrorResult(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as { isError?: unknown }).isError === true
  );
}

type ServerNameReading =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'invalid'; reason: string }>
  | Readonly<{ appCapable: boolean; kind: 'server'; serverName: string }>;

function readMcpServerName(tool: ExecutableTool): ServerNameReading {
  const metadata = tool.mcpMetadata;
  if (metadata === undefined) {
    return { kind: 'absent' };
  }
  if (!(metadata && typeof metadata === 'object' && !Array.isArray(metadata))) {
    return { kind: 'invalid', reason: 'MCP tool execution metadata must be an object' };
  }
  const { appCapable, serverName } = metadata as { appCapable?: unknown; serverName?: unknown };
  if (typeof serverName !== 'string' || serverName.length === 0) {
    return {
      kind: 'invalid',
      reason: 'MCP tool execution metadata requires a non-empty serverName',
    };
  }
  if (appCapable !== undefined && appCapable !== true) {
    return {
      kind: 'invalid',
      reason: 'MCP tool execution metadata appCapable must be true when present',
    };
  }
  return { appCapable: appCapable === true, kind: 'server', serverName };
}

type ToolIdentity =
  | Readonly<{ appCapable: boolean; originalName: string; serverId: string; toolName: string }>
  | Readonly<{ reason: string }>;

/** Namespace-resolves one runtime tool; `undefined` means "not an MCP tool". */
function resolveToolIdentity(
  sanitizedId: string,
  tool: ExecutableTool,
  toolNameMap: ReadonlyMap<string, string>
): ToolIdentity | undefined {
  const reading = readMcpServerName(tool);
  if (reading.kind === 'absent') {
    return;
  }
  if (reading.kind === 'invalid') {
    return { reason: reading.reason };
  }
  const serverId = reading.serverName;
  const originalName = toolNameMap.get(sanitizedId);
  if (originalName === undefined) {
    return { reason: `tool ${sanitizedId} has no namespaced name in the runtime tool map` };
  }
  const namespacePrefix = `${serverId}.`;
  if (!(originalName.startsWith(namespacePrefix) && originalName.length > namespacePrefix.length)) {
    return { reason: `tool ${originalName} does not belong to execution server ${serverId}` };
  }
  return {
    appCapable: reading.appCapable,
    originalName,
    serverId,
    toolName: originalName.slice(namespacePrefix.length),
  };
}

function countAppCapableTools(
  admittedByServer: ReadonlyMap<string, ReadonlyMap<string, Readonly<{ appCapable: boolean }>>>
): number {
  let count = 0;
  for (const serverTools of admittedByServer.values()) {
    for (const admitted of serverTools.values()) {
      if (admitted.appCapable) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Capture the ordinary runtime's exact post-plan/post-permission/post-storage
 * executable entry before artifact/model projection. Each admitted call gets
 * an opaque one-use executor bound to that entry and its server/tool identity;
 * there is no second callback that can substitute a different action.
 */
export function createMcpAppToolAdmissionCapability(
  options: CreateMcpAppToolAdmissionCapabilityOptions
): McpAppToolAdmissionCapability {
  let invocationSequence = 0;
  const admittedByServer = new Map<
    string,
    Map<
      string,
      Readonly<{
        appCapable: boolean;
        decision: 'allow' | 'ask';
        execute: ExecutableTool['execute'];
        receiver: ExecutableTool;
        riskCategory: ToolRiskCategory;
      }>
    >
  >();
  const inadmissible: McpAppInadmissibleTool[] = [];
  const inadmissibleByIdentity = new Map<string, string>();
  for (const [sanitizedId, tool] of Object.entries(options.tools)) {
    if (!isExecutableTool(tool)) {
      continue;
    }
    const identity = resolveToolIdentity(sanitizedId, tool, options.toolNameMap);
    if (identity === undefined) {
      continue;
    }
    if ('reason' in identity) {
      inadmissible.push({ reason: identity.reason, toolId: sanitizedId });
      continue;
    }
    const { appCapable, originalName, serverId, toolName } = identity;
    const ask = options.askTools.get(sanitizedId);
    const serverTools = admittedByServer.get(serverId) ?? new Map();
    if (serverTools.has(toolName)) {
      // Ambiguous identity: neither entry is admissible to Apps.
      const reason = `MCP Apps tool identity ${serverId}/${toolName} is duplicated`;
      serverTools.delete(toolName);
      inadmissibleByIdentity.set(`${serverId}/${toolName}`, reason);
      inadmissible.push({ reason, toolId: sanitizedId });
      admittedByServer.set(serverId, serverTools);
      continue;
    }
    if (inadmissibleByIdentity.has(`${serverId}/${toolName}`)) {
      inadmissible.push({
        reason: inadmissibleByIdentity.get(`${serverId}/${toolName}`) ?? 'duplicated',
        toolId: sanitizedId,
      });
      continue;
    }
    serverTools.set(
      toolName,
      Object.freeze({
        appCapable,
        decision: ask ? 'ask' : 'allow',
        execute: tool.execute,
        receiver: tool,
        riskCategory:
          ask?.riskCategory ??
          options.riskByTool?.[originalName] ??
          options.riskByTool?.[sanitizedId] ??
          options.defaultRisk ??
          'mcp',
      })
    );
    admittedByServer.set(serverId, serverTools);
  }

  const appCapableToolCount = countAppCapableTools(admittedByServer);

  return Object.freeze({
    admit(call: Pick<McpAppToolCall, 'input' | 'serverId' | 'toolName'>) {
      const originalName = `${call.serverId}.${call.toolName}`;
      const admission = admittedByServer.get(call.serverId)?.get(call.toolName);
      if (!admission) {
        throw new McpAppToolNotAdmittedError(
          originalName,
          inadmissibleByIdentity.get(`${call.serverId}/${call.toolName}`)
        );
      }
      invocationSequence += 1;
      const toolCallId = `mcp-app-${invocationSequence}`;
      let consumed = false;
      return Object.freeze({
        decision: admission.decision,
        execute: async ({ signal }: Readonly<{ signal: AbortSignal }>): Promise<unknown> => {
          if (consumed) {
            throw new McpAppToolExecutorConsumedError(originalName);
          }
          consumed = true;
          if (!(signal instanceof AbortSignal)) {
            throw new TypeError('MCP Apps ordinary tool call requires an AbortSignal');
          }
          retainRawMcpCallToolResult(signal);
          return await Reflect.apply(admission.execute, admission.receiver, [
            call.input,
            { abortSignal: signal, agent: { toolCallId } },
          ]);
        },
        riskCategory: admission.riskCategory,
      });
    },
    appCapableToolCount,
    inadmissibleTools: Object.freeze(inadmissible),
    serverIds: Object.freeze(Array.from(admittedByServer.keys())),
  });
}

export function createMcpAppOrdinaryToolCallPreparer(
  options: McpAppOrdinaryToolCallOptions
): (
  call: Pick<McpAppToolCall, 'input' | 'serverId' | 'toolName'>
) => Promise<McpAppPreparedToolCall> {
  return async (call) => {
    const admission = options.admission.admit(call);
    const originalName = `${call.serverId}.${call.toolName}`;

    return Object.freeze({
      decision: admission.decision,
      execute: async ({ signal }: Readonly<{ signal: AbortSignal }>): Promise<unknown> => {
        const startedAt = performance.now();
        let outcome: McpAppToolCallTelemetry['outcome'] = 'failed';
        try {
          const output = await admission.execute({ signal });
          const domainOutput = readHookResultEnvelope(output)?.result ?? output;
          const guardedFailure = isGuardedToolError(domainOutput);
          outcome = signal.aborted
            ? 'cancelled'
            : guardedFailure || isMcpCallToolErrorResult(domainOutput)
              ? 'failed'
              : 'completed';
          if (guardedFailure) {
            return Object.freeze({
              content: Object.freeze([
                Object.freeze({ text: domainOutput.error.message, type: 'text' as const }),
              ]),
              isError: true,
            });
          }
          return domainOutput;
        } finally {
          if (signal.aborted) {
            outcome = 'cancelled';
          }
          try {
            options.onTelemetry?.({
              durationMs: performance.now() - startedAt,
              outcome,
              toolName: originalName,
            });
          } catch (error: unknown) {
            options.logger?.error('MCP Apps tool-call telemetry observer failed', { error });
          }
        }
      },
      riskCategory: admission.riskCategory,
    });
  };
}
