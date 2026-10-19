import { SHELL_OUTPUT_STREAM_PART_TYPE } from './shell-output.js';

/**
 * The `type` of the chunk an MCP tool writes through its tool writer's `custom`
 * for each progress notification its server sends while the call runs.
 */
export const MCP_PROGRESS_STREAM_PART_TYPE = 'brainstrike.mcp-progress.chunk';

/**
 * Whether a tool-writer chunk is live telemetry: a shell-output slice or MCP
 * progress. Telemetry is shown live and never committed to a run log; the tool
 * result that commits later owns the output (ADR-0011 amendment).
 */
export function isToolTelemetryStreamPart(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== 'object') {
    return false;
  }
  const { type } = chunk as Record<string, unknown>;
  return type === SHELL_OUTPUT_STREAM_PART_TYPE || type === MCP_PROGRESS_STREAM_PART_TYPE;
}

/**
 * The `type` of the marker Core sends ahead of a replay when its bound dropped
 * the oldest chunks of a running call, or of the open step's text and
 * reasoning, so a view that subscribed late shows that earlier output is
 * missing (ADR-0011 amendment). Core alone writes it; a tool never does.
 */
export const TOOL_TELEMETRY_OMITTED_TYPE = 'brainstrike.telemetry.omitted';

/** A replay's omission: what the bound dropped, and where the kept output resumes. */
export interface ToolTelemetryOmission {
  /** Bytes of the call's earlier telemetry chunks the replay no longer holds. */
  readonly omittedBytes: number;
  /** The ordinal of the call's first chunk the replay still holds. */
  readonly resumesAt: number;
  /** The call whose output was dropped; absent for the open step's text and reasoning. */
  readonly toolCallId?: string;
}

/** The omission a {@link TOOL_TELEMETRY_OMITTED_TYPE} chunk carries, or undefined for any other chunk. */
export function readToolTelemetryOmission(value: unknown): ToolTelemetryOmission | undefined {
  if (!value || typeof value !== 'object') {
    return;
  }
  const { omittedBytes, resumesAt, toolCallId, type } = value as Record<string, unknown>;
  if (
    type !== TOOL_TELEMETRY_OMITTED_TYPE ||
    !(toolCallId === undefined || (typeof toolCallId === 'string' && toolCallId !== '')) ||
    !Number.isSafeInteger(omittedBytes) ||
    !Number.isSafeInteger(resumesAt) ||
    (omittedBytes as number) <= 0 ||
    (resumesAt as number) < 0
  ) {
    return;
  }
  return {
    omittedBytes: omittedBytes as number,
    resumesAt: resumesAt as number,
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

/**
 * The `type` of the chunk Core sends when a run's Memory made a semantic
 * recall (BST-2225, ADR-0011 amendment): a live diagnostic on the run's
 * stream, never committed and never replayed. The recalled turns themselves
 * reach the provider request from committed history.
 */
export const MEMORY_RECALL_TELEMETRY_TYPE = 'brainstrike.memory.recall';

/** One semantic recall, as its telemetry chunk reports it. */
export interface MemoryRecallTelemetry {
  /** How long the recall took, embedding the query included. */
  readonly latencyMs: number;
  /** The messages recall returned: each hit with its configured message range. */
  readonly messages: number;
  /** Whether recall searched this thread or every thread of the resource. */
  readonly scope: 'resource' | 'thread';
  /** The most hits the recall asks for; absent when the configuration leaves it to Mastra. */
  readonly topK?: number;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The recall a {@link MEMORY_RECALL_TELEMETRY_TYPE} chunk carries, or undefined for any other chunk. */
export function readMemoryRecallTelemetry(value: unknown): MemoryRecallTelemetry | undefined {
  if (!value || typeof value !== 'object') {
    return;
  }
  const { latencyMs, messages, scope, topK, type } = value as Record<string, unknown>;
  if (
    type !== MEMORY_RECALL_TELEMETRY_TYPE ||
    !isCount(latencyMs) ||
    !isCount(messages) ||
    !(scope === 'resource' || scope === 'thread') ||
    !(topK === undefined || (isCount(topK) && topK > 0))
  ) {
    return;
  }
  return { latencyMs, messages, scope, ...(topK === undefined ? {} : { topK }) };
}
