import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import type { McpAppPreparedToolCall, McpAppToolCall } from '@brainstrike/mcp-app-host';
import { guardToolExecution, isGuardedToolError } from '../tools/guard-tool-execution';
import type { AgentHookRunner } from '../tools/hook-runner';
import { readHookResultEnvelope } from '../tools/hook-runner';
import { applyToolHooks } from '../tools/hook-tool-wrap';
import type { ToolLogger } from '../tools/types';
import { resolveToolPermissionDecision } from './permission-tool-gate';
import { sanitizeToolName } from './tool-sanitizer';

export interface McpAppOrdinaryToolCallOptions {
  readonly hookRunner?: AgentHookRunner;
  readonly invoke: (
    call: McpAppToolCall,
    context: Readonly<{ signal: AbortSignal }>
  ) => Promise<unknown>;
  readonly logger?: ToolLogger;
  readonly onTelemetry?: (event: McpAppToolCallTelemetry) => void;
  readonly permissionSnapshot: PermissionToolGateSnapshot;
  readonly timeoutMs: number;
}

export interface McpAppToolCallTelemetry {
  readonly durationMs: number;
  readonly outcome: 'cancelled' | 'completed' | 'failed';
  readonly toolName: string;
}

interface ExecutableTool {
  execute: (...args: unknown[]) => unknown;
}

export function createMcpAppOrdinaryToolCallPreparer(
  options: McpAppOrdinaryToolCallOptions
): (call: McpAppToolCall) => Promise<McpAppPreparedToolCall> {
  let invocationSequence = 0;
  return async (call) => {
    invocationSequence += 1;
    const toolCallId = `mcp-app-${invocationSequence}`;
    const originalName = `${call.serverId}.${call.toolName}`;
    const sanitizedId = sanitizeToolName(originalName);
    const permission = resolveToolPermissionDecision(
      options.permissionSnapshot,
      originalName,
      sanitizedId
    );
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
      decision: permission.decision,
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
      riskCategory: permission.riskCategory,
    });
  };
}
