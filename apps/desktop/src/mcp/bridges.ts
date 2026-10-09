/**
 * Attaches Main's remaining renderer-facing MCP bridges (Apps prepare,
 * execute and release, and Apps shell registration) for one
 * `registerMcpIpcHandlers` lifetime. They own no subscription: they only
 * register invoke handlers, which the registry's `unregisterAll` removes.
 * Durable Tasks cards and global server input are agent-host methods
 * (BST-1930 c5c).
 */
import type { DesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import { getMcpDesktopAppHost } from './apps-authority';
import { attachMcpAppsBridge } from './apps-bridge';
import { attachMcpAppShellBridge } from './apps-shell-bridge';
import { getMcpAppShellRegistry } from './apps-shell-protocol';

export function attachMcpBridges(
  registry: Pick<DesktopIpcRegistry, 'registerAuthorizedInvoke'>
): void {
  attachMcpAppsBridge({ appHost: getMcpDesktopAppHost() }, registry);
  attachMcpAppShellBridge(getMcpAppShellRegistry(), registry);
}
