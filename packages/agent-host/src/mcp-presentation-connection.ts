import { ErrorCodes, type MessageConnection, ResponseError } from 'vscode-jsonrpc';
import type { HostMethodHandler } from './auth-connection.js';
import type { HostClientOrigin, HostMcpPresentationService } from './ports.js';
import { MCP_PRESENTATION_EVENT } from './protocol-mcp-presentation.js';
import { storeRefusal } from './store-refusals.js';

const MAX_VISIBLE_ERROR_CHARS = 1000;

/**
 * The desktop's MCP presentations on one authenticated connection (BST-1930
 * c5c). Only the desktop's private client reaches them: a task card's actions
 * and a server input's answer are the desktop user's, never a CLI's.
 * `mcp/presentation/subscribe` answers the current tasks and starts this
 * connection's `mcp/presentation/event` stream until it closes.
 */
export function bindHostMcpPresentationMethods(
  handle: HostMethodHandler,
  connection: MessageConnection,
  presentation: HostMcpPresentationService | undefined,
  origin: HostClientOrigin
): { dispose(): void } {
  let unsubscribe: (() => void) | undefined;
  const service = (): HostMcpPresentationService => {
    if (origin !== 'desktop-ui') {
      throw new Error("MCP presentations are available only to the desktop's private client");
    }
    if (!presentation) {
      throw new Error('This host presents no MCP tasks or server input');
    }
    return presentation;
  };
  // A window shows each refusal (a stale task handle, a settled input) as the host wrote it.
  // A read-only state store's refusal of a task mutation keeps its type (BST-2144).
  const visible = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (cause) {
      const refused = storeRefusal(cause);
      if (refused !== cause) {
        throw refused;
      }
      throw new ResponseError(
        ErrorCodes.InternalError,
        cause instanceof Error
          ? cause.message.slice(0, MAX_VISIBLE_ERROR_CHARS)
          : 'MCP presentation request failed.'
      );
    }
  };
  handle('mcp/presentation/subscribe', () =>
    visible(async () => {
      const owner = service();
      // Events go out as the typed service produced them; the client validates each.
      unsubscribe ??= owner.subscribe((event) => {
        connection
          .sendNotification(MCP_PRESENTATION_EVENT, event)
          .catch(() => connection.dispose());
      });
      return owner.tasks();
    })
  );
  handle('mcp/tasks/list', () => visible(async () => service().tasks()));
  handle('mcp/tasks/act', (params) => visible(() => service().act(params)));
  handle('mcp/elicitation/settle', (params) =>
    visible(async () => {
      await service().settle(params);
      return { settled: true as const };
    })
  );
  return {
    dispose: () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
