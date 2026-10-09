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
