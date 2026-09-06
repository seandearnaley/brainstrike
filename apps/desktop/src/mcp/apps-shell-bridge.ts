import {
  MCP_APPS_IPC_CHANNELS,
  parseMcpAppShellPrepareRequest,
  parseMcpAppShellPrepareResult,
  parseMcpAppShellReleaseRequest,
} from '@brainstrike/assistant-contract';
import type { DesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import type { McpAppShellRegistry } from './apps-shell-protocol';

const MCP_APPS_SENDER_POLICY = { roles: ['visible-ui'] } as const;

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
    MCP_APPS_IPC_CHANNELS.prepareShell,
    MCP_APPS_SENDER_POLICY,
    async (event, value: unknown) => {
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
    MCP_APPS_IPC_CHANNELS.releaseShell,
    MCP_APPS_SENDER_POLICY,
    async (event, value: unknown): Promise<void> => {
      const { token } = parseMcpAppShellReleaseRequest(value);
      if (!registry.release(event.sender.id, token)) {
        throw new Error('MCP App shell is not registered to this sender');
      }
    }
  );
}
