import type { HostClient } from '@brainstrike/agent-host/browser';
import type {
  HostMethod,
  HostParams,
  HostResults,
  McpPresentationEvent,
  McpSettingsEvent,
} from '@brainstrike/agent-host/protocol';
import type { McpContentCapability } from '@brainstrike/app-shell/mcp-content-capability';
import type { McpStatusCapability } from '@brainstrike/app-shell/mcp-status-capability';
import type { McpToolsCapability } from '@brainstrike/app-shell/mcp-tools-capability';
import type { McpHostOperationResult, McpTaskBridge } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { McpElicitationBridge } from '@brainstrike/settings-ui/settings/tools/mcp-elicitation-capability';
import { connectDesktopAgentHost } from './agent-host-client';
import { unwrapContent } from './mcp-content-outcome';

const logger = createLogger('DesktopHostMcpSettings');

/** The host methods behind the desktop's MCP settings, server status and presentations. */
export type DesktopMcpSettingsMethod = Extract<
  HostMethod,
  | `mcp/config/${string}`
  | `mcp/content/${string}`
  | `mcp/elicitation/${string}`
  | `mcp/extensions/${string}`
  | `mcp/server/${string}`
  | `mcp/status/${string}`
  | `mcp/tasks/${string}`
  | `mcp/tools/${string}`
>;

/**
 * The desktop profile's MCP settings (BST-1930 c5a): the agent host owns the
 * config file, extension dials, tool preferences, the runtime's server status
 * and lifecycle control (c5b), and its Tasks cards and global server input
 * (c5c); this window reads, changes and answers them over its own host client,
 * and hears each change once subscribed.
 */
export interface DesktopHostMcpSettings {
  request<M extends DesktopMcpSettingsMethod>(
    method: M,
    params: HostParams<M>
  ): Promise<HostResults[M]>;
  subscribe(listener: (event: McpSettingsEvent) => void): () => void;
  /** Task changes and server input; this window's presenter follows them once. */
  subscribePresentation(listener: (event: McpPresentationEvent) => void): () => void;
}

/** One host stream: listeners join it, and the first one opens it on the host. */
function hostStream<E>(label: string, open: (dispatch: (event: E) => void) => Promise<void>) {
  let opening: Promise<void> | undefined;
  const listeners = new Set<(event: E) => void>();
  const dispatch = (event: E): void => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  };
  const openOnce = (): void => {
    if (opening) {
      return;
    }
    const attempt = open(dispatch);
    opening = attempt;
    attempt.catch((error: unknown) => {
      // Each surface reports its own read failures; the next listener retries the stream.
      logger.error(`${label} subscription failed`, { error });
      if (opening === attempt) {
        opening = undefined;
      }
    });
  };
  return {
    dispatch,
    subscribe: (listener: (event: E) => void): (() => void) => {
      listeners.add(listener);
      openOnce();
      return () => {
        listeners.delete(listener);
      };
    },
  };
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

/** One host client and one subscription per stream for this window; the frame owns them. */
export function createDesktopHostMcpSettings(
  connect: () => Promise<HostClient>
): DesktopHostMcpSettings {
  let connecting: Promise<HostClient> | undefined;
  const client = (): Promise<HostClient> => {
    if (!connecting) {
      const attempt = connect().then((host) => {
        host.onMcpSettings(settings.dispatch);
        host.onMcpPresentation(presentation.dispatch);
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
  const settings = hostStream<McpSettingsEvent>('MCP settings', async (dispatch) => {
    const { status } = await (await client()).request('mcp/settings/subscribe', {});
    // A status revision the stream started after reaches the listeners that
    // were waiting on it; each reader keeps only newer revisions.
    dispatch({ status, type: 'status' });
  });
  const presentation = hostStream<McpPresentationEvent>('MCP presentation', async (dispatch) => {
    const { tasks } = await (await client()).request('mcp/presentation/subscribe', {});
    // Cards that changed before the stream started reach the listeners waiting on it.
    for (const task of tasks) {
      dispatch({ task, type: 'task' });
    }
  });
  return {
    request: async (method, params) => await (await client()).request(method, params),
    subscribe: settings.subscribe,
    subscribePresentation: presentation.subscribe,
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

/** Live MCP task cards and their recover and cancel actions, from the agent host. */
export function resolveDesktopMcpTaskBridge(): McpTaskBridge | null {
  const settings = resolveDesktopHostMcpSettings();
  if (!settings) {
    return null;
  }
  return {
    act: (request) => settings.request('mcp/tasks/act', request),
    list: () => settings.request('mcp/tasks/list', {}),
    onStatusChanged: (listener) =>
      settings.subscribePresentation((event) => {
        if (event.type === 'task') {
          listener({ task: event.task });
        }
      }),
  };
}

/** Server input no run owns, presented and answered through the agent host. */
export function resolveDesktopMcpElicitationBridge(): McpElicitationBridge | null {
  const settings = resolveDesktopHostMcpSettings();
  if (!settings) {
    return null;
  }
  return {
    onElicitationRequested: (listener) =>
      settings.subscribePresentation((event) => {
        if (event.type === 'elicitation.requested') {
          listener(event.presentation);
        }
      }),
    onElicitationRetired: (listener) =>
      settings.subscribePresentation((event) => {
        if (event.type === 'elicitation.retired') {
          listener({ code: event.code, id: event.id });
        }
      }),
    settleElicitation: async (settlement) => {
      await settings.request('mcp/elicitation/settle', settlement);
    },
  };
}

type ContentResult<Type extends McpHostOperationResult['type']> = Extract<
  McpHostOperationResult,
  { type: Type }
>;
/** MCP content browsing (Settings, composer prompts, MCP App documents), from the agent host. */
export interface DesktopMcpContent extends McpContentCapability {
  /** Settings completes resource arguments as well as prompt arguments. */
  complete(
    request: HostParams<'mcp/content/complete'>
  ): Promise<ContentResult<'completion/complete'>>;
  getPrompt(request: HostParams<'mcp/content/prompt'>): Promise<ContentResult<'prompts/get'>>;
  readResource(request: HostParams<'mcp/content/read'>): Promise<ContentResult<'resources/read'>>;
}

export function resolveDesktopMcpContent(): DesktopMcpContent | null {
  const settings = resolveDesktopHostMcpSettings();
  if (!settings) {
    return null;
  }
  return {
    complete: async (request) =>
      unwrapContent(await settings.request('mcp/content/complete', request)),
    getPrompt: async (request) =>
      unwrapContent(await settings.request('mcp/content/prompt', request)),
    readResource: async (request) =>
      unwrapContent(await settings.request('mcp/content/read', request)),
  };
}
