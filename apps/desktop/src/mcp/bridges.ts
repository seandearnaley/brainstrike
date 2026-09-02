/**
 * Attaches every renderer-facing MCP bridge (Apps prepare/execute/release,
 * elicitation consent, durable Tasks) for one `registerMcpIpcHandlers`
 * lifetime and detaches them in reverse order. The Apps bridge owns no
 * subscription: it only registers invoke handlers, which the registry's
 * `unregisterAll` removes, so it has nothing to detach and nothing to undo
 * when a sibling attach throws.
 */
import type { DesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import { getMcpDesktopAppHost } from './apps-authority';
import { attachMcpAppsBridge } from './apps-bridge';
import { attachMcpAppShellBridge } from './apps-shell-bridge';
import { getMcpAppShellRegistry } from './apps-shell-protocol';
import { attachMcpElicitationBridge, type McpElicitationBridgeRuntime } from './elicitation-bridge';
import { attachMcpTaskBridge, type McpTaskBridgeRuntime } from './task-bridge';

export type McpBridgesRuntime = McpElicitationBridgeRuntime & McpTaskBridgeRuntime;

export function attachMcpBridges(
  runtime: McpBridgesRuntime,
  registry: Pick<DesktopIpcRegistry, 'registerAuthorizedInvoke'>
): () => void {
  attachMcpAppsBridge({ appHost: getMcpDesktopAppHost() }, registry);
  attachMcpAppShellBridge(getMcpAppShellRegistry(), registry);
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
