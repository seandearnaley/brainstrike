/**
 * Attaches Main's remaining renderer-facing MCP bridge, Apps shell
 * registration, for one `registerMcpIpcHandlers` lifetime. It owns no
 * subscription: it only registers invoke handlers, which the registry's
 * `unregisterAll` removes. An MCP App's own tool calls are Core's (BST-1929);
 * durable Tasks cards and global server input are agent-host methods
 * (BST-1930 c5c).
 */
import type { DesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import { attachMcpAppShellBridge } from './apps-shell-bridge';
import { getMcpAppShellRegistry } from './apps-shell-protocol';

export function attachMcpBridges(
  registry: Pick<DesktopIpcRegistry, 'registerAuthorizedInvoke'>
): void {
  attachMcpAppShellBridge(getMcpAppShellRegistry(), registry);
}
