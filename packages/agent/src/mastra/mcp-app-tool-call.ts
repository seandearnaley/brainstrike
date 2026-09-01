import type { ToolRiskCategory } from '@brainstrike/assistant-contract/tool-metadata';
import type { McpAppPreparedToolCall, McpAppToolCall } from '@brainstrike/mcp-app-host';
import type { ToolsInput } from '@mastra/core/agent';
import { guardToolExecution, isGuardedToolError } from '../tools/guard-tool-execution';
import type { AgentHookRunner } from '../tools/hook-runner';
import { readHookResultEnvelope } from '../tools/hook-runner';
import { applyToolHooks } from '../tools/hook-tool-wrap';
import type { ToolLogger } from '../tools/types';
import type { PermissionAskToolMetadata } from './permission-tool-gate';
import { sanitizeToolName } from './tool-sanitizer';

export interface McpAppOrdinaryToolCallOptions {
  readonly admission: McpAppToolAdmissionCapability;
  readonly hookRunner?: AgentHookRunner;
  readonly invoke: (
    call: McpAppToolCall,
    context: Readonly<{ signal: AbortSignal }>
  ) => Promise<unknown>;
  readonly logger?: ToolLogger;
  readonly onTelemetry?: (event: McpAppToolCallTelemetry) => void;
  readonly timeoutMs: number;
}

export interface McpAppToolAdmissionCapability {
  readonly admit: (call: McpAppToolCall) => Readonly<{
    decision: 'allow' | 'ask';
    riskCategory: ToolRiskCategory;
  }>;
}

export interface McpAppToolCallTelemetry {
  readonly durationMs: number;
  readonly outcome: 'cancelled' | 'completed' | 'failed';
  readonly toolName: string;
}

interface ExecutableTool {
  execute: (...args: unknown[]) => unknown;
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

function isExecutableTool(tool: unknown): tool is ExecutableTool {
  return typeof (tool as { execute?: unknown } | undefined)?.execute === 'function';
}

/**
 * Capture the ordinary runtime's final post-plan/post-permission/post-storage
 * admission result. The App transport keeps its canonical CallToolResult, but
 * it cannot prepare or execute a call absent from this capability.
 */
export function createMcpAppToolAdmissionCapability(
  options: CreateMcpAppToolAdmissionCapabilityOptions
): McpAppToolAdmissionCapability {
  const admitted = new Map<
    string,
    Readonly<{ decision: 'allow' | 'ask'; riskCategory: ToolRiskCategory }>
  >();
  for (const [sanitizedId, tool] of Object.entries(options.tools)) {
    if (!isExecutableTool(tool)) {
      continue;
    }
    const originalName = options.toolNameMap.get(sanitizedId) ?? sanitizedId;
    const ask = options.askTools.get(sanitizedId);
    admitted.set(
      originalName,
      Object.freeze({
        decision: ask ? 'ask' : 'allow',
        riskCategory:
          ask?.riskCategory ??
          options.riskByTool?.[originalName] ??
          options.riskByTool?.[sanitizedId] ??
          options.defaultRisk ??
          'mcp',
      })
    );
  }

  return Object.freeze({
    admit(call: McpAppToolCall) {
      const originalName = `${call.serverId}.${call.toolName}`;
      const admission = admitted.get(originalName);
      if (!admission) {
        throw new McpAppToolNotAdmittedError(originalName);
      }
      return admission;
    },
  });
}

export function createMcpAppOrdinaryToolCallPreparer(
  options: McpAppOrdinaryToolCallOptions
): (call: McpAppToolCall) => Promise<McpAppPreparedToolCall> {
  let invocationSequence = 0;
  return async (call) => {
    const admission = options.admission.admit(call);
    invocationSequence += 1;
    const toolCallId = `mcp-app-${invocationSequence}`;
    const originalName = `${call.serverId}.${call.toolName}`;
    const sanitizedId = sanitizeToolName(originalName);
    const base: ExecutableTool = {
      execute: async (_input: unknown, context: unknown): Promise<unknown> => {
        const signal = (context as { abortSignal?: unknown } | undefined)?.abortSignal;
        if (!(signal instanceof AbortSignal)) {
          throw new TypeError('MCP Apps ordinary tool call requires an AbortSignal');
        }
        return await options.invoke(call, { signal });
      },
    };
    const guarded = guardToolExecution(base, {
      ...(options.logger ? { logger: options.logger } : {}),
      timeoutMs: options.timeoutMs,
      toolName: originalName,
    });
    const wrapped = options.hookRunner
      ? (applyToolHooks(
          { [sanitizedId]: guarded },
          {
            hookRunner: options.hookRunner,
            ...(options.logger ? { logger: options.logger } : {}),
            toolNameMap: new Map([[sanitizedId, originalName]]),
          }
        )[sanitizedId] as ExecutableTool)
      : guarded;

    return Object.freeze({
      decision: admission.decision,
      execute: async ({ signal }: Readonly<{ signal: AbortSignal }>): Promise<unknown> => {
        const startedAt = performance.now();
        let outcome: McpAppToolCallTelemetry['outcome'] = 'failed';
        try {
          const output = await wrapped.execute(
            { context: call.input },
            { abortSignal: signal, agent: { toolCallId } }
          );
          const domainOutput = readHookResultEnvelope(output)?.result ?? output;
          outcome = signal.aborted
            ? 'cancelled'
            : isGuardedToolError(domainOutput)
              ? 'failed'
              : 'completed';
          if (isGuardedToolError(domainOutput)) {
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
