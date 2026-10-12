import {
  parseMcpAppShellPrepareRequest,
  parseMcpAppShellPrepareResult,
  parseMcpAppShellReleaseRequest,
} from '@brainstrike/assistant-contract';
import { mcpAppsContract } from '../ipc-domains/mcp.contract';
import type { DesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import type { McpAppShellRegistry } from './apps-shell-protocol';

/** The slice of a WebContents the shell bridge binds a registration to. */
export interface McpAppShellSender {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
}

/**
 * Visible-UI-only IPC for the MCP App shell registry (BST-1572). Every shell
 * is bound to the registering WebContents: only that sender can release it,
 * and the sender's destruction drops all of its shells so a torn-down window
 * can never leave a shell served.
 */
export function attachMcpAppShellBridge(
  registry: Pick<McpAppShellRegistry, 'register' | 'release' | 'releaseOwner'>,
  ipc: Pick<DesktopIpcRegistry, 'registerAuthorizedInvoke'>
): void {
  const trackedSenders = new Set<number>();
  const track = (sender: McpAppShellSender): void => {
    if (trackedSenders.has(sender.id)) {
      return;
    }
    trackedSenders.add(sender.id);
    sender.once('destroyed', () => {
      trackedSenders.delete(sender.id);
      registry.releaseOwner(sender.id);
    });
  };

  ipc.registerAuthorizedInvoke(
    'mcp',
    mcpAppsContract.prepareShell.channel,
    { roles: mcpAppsContract.prepareShell.roles },
    async (event, ...raw: unknown[]) => {
      const [value] = mcpAppsContract.prepareShell.parseArgs(raw);
      const sender: McpAppShellSender = event.sender;
      if (sender.isDestroyed()) {
        throw new Error('MCP App shell registration from a destroyed WebContents');
      }
      const lease = registry.register(sender.id, parseMcpAppShellPrepareRequest(value));
      track(sender);
      return parseMcpAppShellPrepareResult(lease);
    }
  );
  ipc.registerAuthorizedInvoke(
    'mcp',
    mcpAppsContract.releaseShell.channel,
    { roles: mcpAppsContract.releaseShell.roles },
    async (event, ...raw: unknown[]): Promise<void> => {
      const [value] = mcpAppsContract.releaseShell.parseArgs(raw);
      const { token } = parseMcpAppShellReleaseRequest(value);
      if (!registry.release(event.sender.id, token)) {
        throw new Error('MCP App shell is not registered to this sender');
      }
    }
  );
}
