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

export interface McpAppToolAdmissionCapability {
  readonly admit: (call: McpAppToolCall) => McpAppBoundOrdinaryExecutor;
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

  constructor(toolName: string) {
    super(`MCP Apps tool ${toolName} is not admitted by the ordinary runtime`);
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

function readMcpServerName(tool: ExecutableTool): string | undefined {
  const metadata = tool.mcpMetadata;
  if (metadata === undefined) {
    return;
  }
  if (!(metadata && typeof metadata === 'object' && !Array.isArray(metadata))) {
    throw new TypeError('MCP tool execution metadata must be an object');
  }
  const serverName = (metadata as { serverName?: unknown }).serverName;
  if (typeof serverName !== 'string' || serverName.length === 0) {
    throw new TypeError('MCP tool execution metadata requires a non-empty serverName');
  }
  return serverName;
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
        decision: 'allow' | 'ask';
        execute: ExecutableTool['execute'];
        receiver: ExecutableTool;
        riskCategory: ToolRiskCategory;
      }>
    >
  >();
  for (const [sanitizedId, tool] of Object.entries(options.tools)) {
    if (!isExecutableTool(tool)) {
      continue;
    }
    const serverId = readMcpServerName(tool);
    if (serverId === undefined) {
      continue;
    }
    const originalName = options.toolNameMap.get(sanitizedId) ?? sanitizedId;
    const namespacePrefix = `${serverId}.`;
    if (
      !(originalName.startsWith(namespacePrefix) && originalName.length > namespacePrefix.length)
    ) {
      throw new TypeError(
        `MCP tool ${originalName} does not belong to execution server ${serverId}`
      );
    }
    const toolName = originalName.slice(namespacePrefix.length);
    const ask = options.askTools.get(sanitizedId);
    const serverTools = admittedByServer.get(serverId) ?? new Map();
    if (serverTools.has(toolName)) {
      throw new TypeError(`MCP Apps tool identity ${serverId}/${toolName} is duplicated`);
    }
    serverTools.set(
      toolName,
      Object.freeze({
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

  return Object.freeze({
    admit(call: McpAppToolCall) {
      const originalName = `${call.serverId}.${call.toolName}`;
      const admission = admittedByServer.get(call.serverId)?.get(call.toolName);
      if (!admission) {
        throw new McpAppToolNotAdmittedError(originalName);
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
  });
}

export function createMcpAppOrdinaryToolCallPreparer(
  options: McpAppOrdinaryToolCallOptions
): (call: McpAppToolCall) => Promise<McpAppPreparedToolCall> {
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
