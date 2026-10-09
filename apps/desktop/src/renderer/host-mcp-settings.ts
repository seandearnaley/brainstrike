import type { HostClient } from '@brainstrike/agent-host/browser';
import type {
  HostMethod,
  HostParams,
  HostResults,
  McpSettingsEvent,
} from '@brainstrike/agent-host/protocol';
import type { McpStatusCapability } from '@brainstrike/app-shell/mcp-status-capability';
import type { McpToolsCapability } from '@brainstrike/app-shell/mcp-tools-capability';
import { createLogger } from '@brainstrike/logging';
import { connectDesktopAgentHost } from './agent-host-client';

const logger = createLogger('DesktopHostMcpSettings');

/** The host methods that read and change the desktop's MCP settings and server status. */
export type DesktopMcpSettingsMethod = Extract<
  HostMethod,
  | `mcp/config/${string}`
  | `mcp/extensions/${string}`
  | `mcp/server/${string}`
  | `mcp/status/${string}`
  | `mcp/tools/${string}`
>;

/**
 * The desktop profile's MCP settings (BST-1930 c5a): the agent host owns the
 * config file, extension dials, tool preferences, and the runtime's server
 * status and lifecycle control (c5b); this window reads and changes them over
 * its own host client, and hears each change once subscribed.
 */
export interface DesktopHostMcpSettings {
  request<M extends DesktopMcpSettingsMethod>(
    method: M,
    params: HostParams<M>
  ): Promise<HostResults[M]>;
  subscribe(listener: (event: McpSettingsEvent) => void): () => void;
}

let windowSettings: DesktopHostMcpSettings | undefined;

/** `null` where this window has no agent-host capability (web, hidden hosts). */
export function resolveDesktopHostMcpSettings(): DesktopHostMcpSettings | null {
  if (!window.agentHost) {
    return null;
  }
  windowSettings ??= createDesktopHostMcpSettings(connectDesktopAgentHost);
  return windowSettings;
}

/** One host client and one settings subscription for this window; the frame owns them. */
export function createDesktopHostMcpSettings(
  connect: () => Promise<HostClient>
): DesktopHostMcpSettings {
  let connecting: Promise<HostClient> | undefined;
  let subscribing: Promise<void> | undefined;
  const listeners = new Set<(event: McpSettingsEvent) => void>();
  const dispatch = (event: McpSettingsEvent): void => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  };
  const client = (): Promise<HostClient> => {
    if (!connecting) {
      const attempt = connect().then((host) => {
        host.onMcpSettings(dispatch);
        return host;
      });
      connecting = attempt;
      attempt.catch(() => {
        if (connecting === attempt) {
          connecting = undefined;
        }
      });
      window.addEventListener(
        'beforeunload',
        () => {
          void attempt.then(
            (host) => host.close(),
            () => undefined
          );
        },
        { once: true }
      );
    }
    return connecting;
  };
  const subscribeOnce = (): void => {
    if (subscribing) {
      return;
    }
    const attempt = client().then(async (host) => {
      const { status } = await host.request('mcp/settings/subscribe', {});
      // A status revision the stream started after reaches the listeners that
      // were waiting on it; each reader keeps only newer revisions.
      dispatch({ status, type: 'status' });
    });
    subscribing = attempt;
    attempt.catch((error: unknown) => {
      // Settings reports its own read failures; the next subscriber retries the stream.
      logger.error('MCP settings subscription failed', { error });
      if (subscribing === attempt) {
        subscribing = undefined;
      }
    });
  };
  return {
    request: async (method, params) => await (await client()).request(method, params),
    subscribe: (listener) => {
      listeners.add(listener);
      subscribeOnce();
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The composer's Tools menu over the host's discovered tools and their preferences. */
export function resolveDesktopMcpToolsCapability(): McpToolsCapability | null {
  const settings = resolveDesktopHostMcpSettings();
  if (!settings) {
    return null;
  }
  return {
    list: () => settings.request('mcp/tools/list', {}),
    setEnabled: async (toolIds, enabled) => {
      await settings.request('mcp/tools/set', { enabled, toolIds: [...toolIds] });
    },
    subscribe: (listener) =>
      settings.subscribe((event) => {
        if (event.type === 'tools') {
          listener(event.tools);
        }
      }),
  };
}

/** The runtime's server status, as the composer's prompt affordances and MCP Apps follow it. */
export function resolveDesktopMcpStatusCapability(): McpStatusCapability | null {
  const settings = resolveDesktopHostMcpSettings();
  if (!settings) {
    return null;
  }
  return {
    read: () => settings.request('mcp/status/read', {}),
    subscribe: (listener) =>
      settings.subscribe((event) => {
        if (event.type === 'status') {
          listener(event.status);
        }
      }),
  };
}
