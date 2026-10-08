/**
 * MCP Tasks IPC bridge (BST-1566).
 *
 * Mirrors `elicitation-bridge.ts`: the process-local `McpDesktopTaskHost`
 * owns every task authority; renderers see browser-safe presentations only.
 * Presentation changes are pushed on `mcp:task:status-changed` to tracked
 * visible-UI windows, `mcp:task:list` returns the live presentation set, and
 * `mcp:task:act` runs one card action (recover / cancel) through the host's
 * presentation controller fence. Action payloads are parsed with the shared
 * contract parser before they reach the host, and both invoke channels carry
 * the visible-UI sender policy (same as `mcp:content:*` and elicitation).
 */
import {
  MCP_TASK_LIST_LIMIT,
  type McpTaskActionResult,
  type McpTaskListResult,
  type McpTaskStatusChangedEvent,
  parseMcpTaskActionRequest,
  parseMcpTaskListResult,
} from '@brainstrike/assistant-contract';
import type { McpDesktopTaskHostPort } from '@brainstrike/host-capabilities/mcp/task-host';
import { mcpTasksContract } from '../ipc-domains/mcp.contract';
import { type DesktopIpcRegistry, registerDomain } from '../platform/desktop-ipc-registry';
import type { Handlers } from '../platform/ipc-contract';
import { getTrackedWindowsByRole } from '../window-role';

export class McpTaskBridgeError extends Error {
  constructor(readonly code: 'mcp-task-action-malformed') {
    super(`MCP task action failed: ${code}`);
    this.name = 'McpTaskBridgeError';
  }
}

export interface McpTaskBridgeRuntime {
  readonly taskHost: Pick<McpDesktopTaskHostPort, 'act' | 'list' | 'subscribe'>;
}

function broadcast(channel: string, payload: unknown): void {
  const cloned = structuredClone(payload);
  for (const window of getTrackedWindowsByRole('visible-ui')) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, cloned);
    }
  }
}

export function attachMcpTaskBridge(
  runtime: McpTaskBridgeRuntime,
  registry: Pick<DesktopIpcRegistry, 'registerAuthorizedInvoke'>
): () => void {
  const { taskHost } = runtime;
  const unsubscribe = taskHost.subscribe((task) => {
    const event: McpTaskStatusChangedEvent = { task };
    broadcast(mcpTasksContract.onStatusChanged.channel, event);
  });
  const handlers: Handlers<typeof mcpTasksContract> = {
    act: (request): Promise<McpTaskActionResult> => {
      let parsed: ReturnType<typeof parseMcpTaskActionRequest>;
      try {
        parsed = parseMcpTaskActionRequest(request);
      } catch {
        throw new McpTaskBridgeError('mcp-task-action-malformed');
      }
      return taskHost.act(parsed);
    },
    list: (): McpTaskListResult => {
      const { tasks } = taskHost.list();
      // The wire schema caps the list; the host keeps at most that many.
      return parseMcpTaskListResult({ tasks: tasks.slice(-MCP_TASK_LIST_LIMIT) });
    },
  };
  registerDomain(registry, 'mcp', mcpTasksContract, handlers);
  return unsubscribe;
}
