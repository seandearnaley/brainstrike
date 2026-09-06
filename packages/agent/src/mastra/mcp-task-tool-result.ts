import {
  createMcpTaskToolInvocationResult,
  type McpTaskToolInvocationResult,
  readMcpTaskToolInvocationResult,
} from '@brainstrike/assistant-contract';
import {
  type CreateTaskResult,
  parseMcpCreateTaskResult,
} from '@brainstrike/mcp-tasks-extension/task';
import { readRegisteredExtensionResult } from '../mcp/client-extension-registry';
import {
  MCP_TASK_CONTEXT_MAX_BYTES,
  type McpTaskContextProjection,
  projectMcpTaskForContext,
} from '../mcp/task-presentation';
import type { McpTaskTrackingCapability } from '../mcp/task-tracking';
import { getActiveToolResultBudget } from './tool-model-output';

/**
 * How long a task-creating MCP tool call waits for a terminal status before
 * returning the live presentation. The wait rides inside the tool guard's
 * single ceiling (`BRAINSTRIKE_TOOL_TIMEOUT_MS`, default 60s), which is not
 * observable from inside `execute`, so the bound is fixed here and capped at
 * three quarters of that ceiling: the remaining quarter covers the original
 * `tools/call` round trip plus `track()` so the guard never wins the race and
 * reports a timed-out tool for a task that is tracked and healthy.
 */
export const MCP_TASK_SETTLEMENT_WAIT_MS = 45_000;
const GUARD_SHARE_NUMERATOR = 3;
const GUARD_SHARE_DENOMINATOR = 4;
/** `{"type":"json","value":` + `}` around the projection. */
const JSON_MODEL_OUTPUT_ENVELOPE_CHARS = 24;

export interface McpTaskToolTracking {
  readonly capability: McpTaskTrackingCapability;
  readonly settlementTimeoutMs: number;
}

export function resolveMcpTaskSettlementTimeoutMs(toolTimeoutMs: number): number {
  if (!(Number.isSafeInteger(toolTimeoutMs) && toolTimeoutMs > 0)) {
    throw new RangeError(
      `MCP task settlement requires a positive integer tool timeout; received ${String(toolTimeoutMs)}`
    );
  }
  const guardShare = Math.floor((toolTimeoutMs * GUARD_SHARE_NUMERATOR) / GUARD_SHARE_DENOMINATOR);
  const timeoutMs = Math.min(MCP_TASK_SETTLEMENT_WAIT_MS, guardShare);
  if (timeoutMs < 1) {
    throw new RangeError(
      `MCP task settlement cannot fit under a ${toolTimeoutMs}ms tool timeout; raise BRAINSTRIKE_TOOL_TIMEOUT_MS`
    );
  }
  return timeoutMs;
}

export function createMcpTaskToolTracking(
  capability: McpTaskTrackingCapability,
  toolTimeoutMs: number
): McpTaskToolTracking {
  return { capability, settlementTimeoutMs: resolveMcpTaskSettlementTimeoutMs(toolTimeoutMs) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Detects a created task in either shape a `tools/call` response can take on
 * this client: the bare `resultType: 'task'` result, or the client extension
 * registry's neutral `complete` envelope carrying it. A malformed task throws;
 * anything else is an ordinary tool result.
 */
export function readMcpCreatedTaskResult(result: unknown): CreateTaskResult | undefined {
  const candidate = readRegisteredExtensionResult(result) ?? result;
  if (!isRecord(candidate) || candidate['resultType'] !== 'task') {
    return;
  }
  return parseMcpCreateTaskResult(candidate);
}

export interface SettleMcpTaskToolResultInput {
  readonly configuredServerId: string;
  readonly result: CreateTaskResult;
  readonly signal?: AbortSignal;
  readonly toolName: string;
  readonly tracking: McpTaskToolTracking | undefined;
}

/**
 * Hands the created task to the host's task authorities and settles the tool
 * on the bounded presentation: terminal when the task finishes inside the
 * wait, otherwise the live presentation the status card keeps updating.
 */
export async function settleMcpTaskToolResult(
  input: SettleMcpTaskToolResultInput
): Promise<McpTaskToolInvocationResult> {
  const { configuredServerId, result, signal, toolName, tracking } = input;
  if (!tracking) {
    throw new Error(
      `MCP tool "${configuredServerId}.${toolName}" returned a task but this host has no task tracking capability`
    );
  }
  const initial = await tracking.capability.track({ configuredServerId, result, toolName }, signal);
  const outcome = await tracking.capability.awaitSettlement(initial.handle, {
    ...(signal ? { signal } : {}),
    timeoutMs: tracking.settlementTimeoutMs,
  });
  return createMcpTaskToolInvocationResult(outcome.task);
}

export interface McpTaskToolModelOutput {
  readonly type: 'json';
  readonly value: McpTaskContextProjection;
}

/**
 * Model projection for MCP tools on a tracking-capable host. Only the
 * persisted task marker is projected (status, bounded history, bounded status
 * message — never the control handle or raw task state); every other result
 * returns `undefined` so the pipeline applies its generic projection.
 */
export function projectMcpTaskToolModelOutput(output: unknown): McpTaskToolModelOutput | undefined {
  const task = readMcpTaskToolInvocationResult(output);
  if (!task) {
    return;
  }
  const budget = getActiveToolResultBudget();
  // UTF-8 bytes are never fewer than UTF-16 code units, so bounding the
  // projection's bytes to the run's domain char budget also bounds its chars.
  const maxBytes = budget
    ? Math.min(
        MCP_TASK_CONTEXT_MAX_BYTES,
        budget.domainModelResultCharBudget - JSON_MODEL_OUTPUT_ENVELOPE_CHARS
      )
    : MCP_TASK_CONTEXT_MAX_BYTES;
  return { type: 'json', value: projectMcpTaskForContext(task, maxBytes) };
}
