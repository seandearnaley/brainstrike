import { readMcpCreatedTaskResult } from '@brainstrike/agent';
import type { HostMcpAppToolCall } from '@brainstrike/agent-host';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import type { McpHostRuntime } from './node-host-runtime.js';

/**
 * An MCP App's own tool call, once Core has admitted it: one `tools/call` on
 * the app's configured server, answered with the complete CallToolResult the
 * app's client expects. A created task goes to the host's task authority, as
 * it does for a model's call, and the app gets the canonical CreateTaskResult
 * without waiting for the task to settle.
 */
export async function callMcpAppTool(
  runtime: Pick<McpHostRuntime, 'host' | 'taskHost'>,
  call: HostMcpAppToolCall,
  signal: AbortSignal
): Promise<unknown> {
  const configuredServerId = parseConfiguredMcpServerId(call.serverId);
  const outcome = await runtime.host.invoke(
    { arguments: call.arguments, configuredServerId, toolName: call.toolName, type: 'tools/call' },
    { signal }
  );
  if (outcome.type !== 'tools/call') {
    throw new Error(`MCP App tool call expected a tools/call result, received ${outcome.type}`);
  }
  const createdTask = readMcpCreatedTaskResult(outcome.result);
  if (createdTask) {
    await runtime.taskHost.track(
      { configuredServerId, result: createdTask, toolName: call.toolName },
      signal
    );
  }
  return outcome.result;
}
