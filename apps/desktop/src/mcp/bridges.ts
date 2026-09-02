/**
 * Attaches every renderer-facing MCP bridge (elicitation consent, durable
 * Tasks) for one `registerMcpIpcHandlers` lifetime and detaches them in
 * reverse order.
 */
import type { DesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import { getMcpDesktopAppHost } from './apps-authority';
import { attachMcpAppsBridge } from './apps-bridge';
import { attachMcpElicitationBridge, type McpElicitationBridgeRuntime } from './elicitation-bridge';
import { attachMcpTaskBridge, type McpTaskBridgeRuntime } from './task-bridge';

export type McpBridgesRuntime = McpElicitationBridgeRuntime & McpTaskBridgeRuntime;

export function attachMcpBridges(
  runtime: McpBridgesRuntime,
  registry: Pick<DesktopIpcRegistry, 'registerAuthorizedInvoke'>
): () => void {
  attachMcpAppsBridge({ appHost: getMcpDesktopAppHost() }, registry);
  const detachElicitation = attachMcpElicitationBridge(runtime, registry);
  let detachTasks: () => void;
  try {
    detachTasks = attachMcpTaskBridge(runtime, registry);
  } catch (error) {
    detachElicitation();
    throw error;
  }
  return () => {
    detachTasks();
    detachElicitation();
  };
}
