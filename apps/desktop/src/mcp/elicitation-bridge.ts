/**
 * MCP elicitation IPC bridge (BST-1584).
 *
 * Connects the process-local `McpElicitationPresenterAuthority` to every live
 * renderer window: presentations are pushed on `mcp:elicitation:requested`,
 * finalizations (settlement, abort, retirement, detach, close) are pushed on
 * `mcp:elicitation:retired` so a dialog never goes dead, and the renderer
 * answers through the `mcp:elicitation:settle` invoke channel. The renderer's
 * settlement is parsed with the browser-safe contract parser before it reaches
 * the presenter; presenter failures are mapped to a stable code-only error so
 * no cause detail leaks across the IPC boundary.
 *
 * The presenter allows exactly one attached listener, so this bridge attaches
 * once per registration and detaches (rejecting every pending presentation
 * with `mcp-elicitation-presenter-unavailable`) when unregistered.
 */
import {
  type McpElicitationPresentationWire,
  type McpElicitationRetiredWire,
  type McpElicitationSettlement,
  parseMcpElicitationSettlement,
} from '@brainstrike/assistant-contract';
import {
  type McpElicitationPresentation,
  type McpElicitationPresenterAuthority,
  McpElicitationPresenterError,
  type McpElicitationPresenterErrorCode,
} from '@brainstrike/host-capabilities/mcp/elicitation-presenter';
import { mcpElicitationContract } from '../ipc-domains/mcp.contract';
import { type DesktopIpcRegistry, registerDomain } from '../platform/desktop-ipc-registry';
import type { Handlers } from '../platform/ipc-contract';
import { getTrackedWindowsByRole } from '../window-role';

export type McpElicitationBridgeErrorCode =
  | McpElicitationPresenterErrorCode
  | 'mcp-elicitation-settlement-malformed';

export class McpElicitationBridgeError extends Error {
  constructor(readonly code: McpElicitationBridgeErrorCode) {
    super(`MCP elicitation settlement failed: ${code}`);
    this.name = 'McpElicitationBridgeError';
  }
}

export interface McpElicitationBridgeRuntime {
  readonly elicitationPresenter: Pick<
    McpElicitationPresenterAuthority,
    'attach' | 'observeFinalized'
  > & {
    /** Local or remote: the Node host's presenter settles over the private connection. */
    settle(settlement: McpElicitationSettlement): Promise<void> | void;
  };
}

/**
 * Consent payloads (server message, requested schema, a URL-mode
 * authorization URL) go only to tracked visible-UI windows, never to hidden
 * inference hosts or untracked windows.
 */
function broadcast(channel: string, payload: unknown): void {
  const cloned = structuredClone(payload);
  for (const window of getTrackedWindowsByRole('visible-ui')) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, cloned);
    }
  }
}

export function attachMcpElicitationBridge(
  runtime: McpElicitationBridgeRuntime,
  registry: Pick<DesktopIpcRegistry, 'registerAuthorizedInvoke'>
): () => void {
  const { elicitationPresenter } = runtime;
  const detach = elicitationPresenter.attach((presentation: McpElicitationPresentation) => {
    const wire: McpElicitationPresentationWire = presentation;
    broadcast(mcpElicitationContract.onElicitationRequested.channel, wire);
  });
  let stopObserving: () => void;
  try {
    stopObserving = elicitationPresenter.observeFinalized(({ code, id }) => {
      const wire: McpElicitationRetiredWire = { code, id };
      broadcast(mcpElicitationContract.onElicitationRetired.channel, wire);
    });
  } catch (error) {
    detach();
    throw error;
  }
  // A settlement can accept form content or authorize opening a URL, and the
  // presentation is broadcast to every window, so only the visible UI may
  // settle: hidden inference hosts and untracked senders are rejected before
  // the payload is parsed (same policy as secrets and mcp:content:*).
  const handlers: Handlers<typeof mcpElicitationContract> = {
    settleElicitation: async (settlement): Promise<void> => {
      let parsed: ReturnType<typeof parseMcpElicitationSettlement>;
      try {
        parsed = parseMcpElicitationSettlement(settlement);
      } catch {
        throw new McpElicitationBridgeError('mcp-elicitation-settlement-malformed');
      }
      try {
        await elicitationPresenter.settle(parsed);
      } catch (error) {
        throw new McpElicitationBridgeError(
          error instanceof McpElicitationPresenterError
            ? error.code
            : 'mcp-elicitation-settlement-invalid'
        );
      }
    },
  };
  registerDomain(registry, 'mcp', mcpElicitationContract, handlers);
  return () => {
    // Detach first so the resulting `presenter-unavailable` finalizations still
    // reach the renderer before the observer is removed.
    detach();
    stopObserving();
  };
}
