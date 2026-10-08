import {
  createMcpRuntimeClient,
  type McpDiscoverySkip,
  type McpRuntimeClient,
} from '@brainstrike/agent/mcp-client';
import type {
  HostMcpRuntime,
  HostMcpToolRequest,
  HostMcpToolSelection,
  HostMcpUnavailableServer,
  HostStartupContext,
} from '@brainstrike/agent-host';
import { joinCredentialCleanup } from '@brainstrike/agent-host/credential-contract';
import type { McpExtensionEnablement, McpHostCloseReport } from '@brainstrike/assistant-contract';
import type { ResolvedMcpConfig } from '@brainstrike/assistant-contract/mcp-config';
import type { McpTaskDatabase } from '@brainstrike/db';
import type { McpBearerCredentialAuthority } from './bearer-credential.js';
import type { McpElicitationPresenterAuthority } from './elicitation-presenter.js';
import { type AgentHostMcpCollection, bindMcpTool } from './mcp-tool-binding.js';
import { McpHostRuntime, type McpHostRuntimeDependencies } from './node-host-runtime.js';
import type { McpOAuthStore } from './oauth-client-provider.js';

export class AgentHostAdapterClosedError extends Error {
  readonly code = 'agent_host_adapter_closed';
  constructor() {
    super('Agent host adapter services are closing.');
    this.name = 'AgentHostAdapterClosedError';
  }
}

/** The collector and its publication policy, injected by each host composition. */
export interface McpHostCollector<Collection extends AgentHostMcpCollection> {
  /** Bind exact questions/URL consent through the canonical dispatcher before connecting. */
  readonly attachElicitationPresenter: (presenter: McpElicitationPresenterAuthority) => () => void;
  /** Inject the existing collector, including Settings filters and result bounds. */
  readonly collectCombinedTools: (options: {
    readonly durableArtifactSettlement: false;
    readonly mcpClient: McpRuntimeClient | undefined;
    readonly mcpConfig: undefined;
    readonly sanitizedLocalTools: undefined;
    readonly scaledDefaultTokens: number;
    readonly timeoutOverrideMs: undefined;
    readonly toolNameMap: Map<string, string>;
  }) => Promise<Collection>;
  readonly runtimeDependencies?: McpHostRuntimeDependencies;
}

/** Process-local MCP composition. Credentials are the caller's existing stores. */
export interface McpHostServicesOptions<Collection extends AgentHostMcpCollection>
  extends McpHostCollector<Collection> {
  readonly appUi: 'rich' | 'text';
  readonly bearerCredentialAuthority: McpBearerCredentialAuthority;
  /** Global extension dials applied before the first configuration commits. */
  readonly extensionPreferences?: McpExtensionEnablement;
  /** A caller-owned fence: true once the composing owner has started closing. */
  readonly isClosing?: () => boolean;
  readonly mcpConfiguration: ResolvedMcpConfig;
  readonly oauthStore: McpOAuthStore;
  readonly openExternal: (url: string) => Promise<void>;
  /** Borrow the existing Tasks writer; this composition never constructs another database. */
  readonly openTaskDatabase: () => Promise<McpTaskDatabase>;
  readonly startup: Pick<HostStartupContext, 'signal'>;
}

export interface McpHostServices {
  /** Joins borrowed clients, the runtime's requests, Tasks and credential persistence. */
  close(): Promise<McpHostCloseReport>;
  readonly mcp: HostMcpRuntime;
  readonly runtime: McpHostRuntime;
}

/**
 * A run proceeds without each server whose discovery failed. A client-wide
 * failure names every server it covered, with the one shared reason.
 */
function unavailableServers(
  skips: readonly McpDiscoverySkip[]
): readonly HostMcpUnavailableServer[] {
  return skips.flatMap((skip) =>
    skip.scope === 'server'
      ? [{ reason: skip.reason, serverId: skip.serverName }]
      : skip.serverNames.map((serverId) => ({ reason: skip.reason, serverId }))
  );
}

/**
 * The one MCP runtime a host process owns, with admission's executable tool
 * selection. The caller registers `close` with its startup owner before any
 * side effect and decides where credentials, config and the Tasks DB come from.
 */
export async function createMcpHostServices<Collection extends AgentHostMcpCollection>(
  options: McpHostServicesOptions<Collection>
): Promise<McpHostServices> {
  const clients = new Set<McpRuntimeClient>();
  const collections = new Set<Promise<HostMcpToolSelection>>();
  let configuration: Promise<unknown> | undefined;
  let detachElicitation: (() => void) | undefined;
  let closing: Promise<McpHostCloseReport> | undefined;
  const ensureOpen = (): void => {
    options.startup.signal.throwIfAborted();
    if (closing || options.isClosing?.()) {
      throw new AgentHostAdapterClosedError();
    }
  };
  const runtime = new McpHostRuntime(
    {
      appUi: options.appUi,
      bearerCredentialAuthority: options.bearerCredentialAuthority,
      oauthStore: options.oauthStore,
      openExternal: options.openExternal,
      openTaskDatabase: options.openTaskDatabase,
    },
    options.runtimeDependencies
  );
  const close = (): Promise<McpHostCloseReport> => {
    closing ??= Promise.resolve().then(async () => {
      let report: McpHostCloseReport | undefined;
      // The shared authority joins actual requests, Tasks and OAuth persistence.
      // A discovery timeout or caller abort is never treated as that receipt.
      await joinCredentialCleanup(
        [
          ...[...clients].map((client) => client.disconnect()),
          Promise.resolve().then(async () => {
            report = await runtime.host.close();
          }),
        ],
        'Agent host MCP adapter cleanup failed.',
        () => [
          Promise.allSettled([configuration, ...collections]).then(async () => {
            // A borrowed client can finish acquisition after shutdown starts.
            await joinCredentialCleanup(
              [
                ...[...clients].map((client) => client.disconnect()),
                Promise.resolve().then(() => detachElicitation?.()),
              ],
              'MCP borrowed client cleanup failed.'
            );
            clients.clear();
          }),
        ]
      );
      if (!report) {
        throw new Error('Agent host MCP runtime was not constructed.');
      }
      return report;
    });
    return closing;
  };
  try {
    ensureOpen();
    detachElicitation = options.attachElicitationPresenter(runtime.elicitationPresenter);
    if (options.extensionPreferences) {
      await runtime.setMcpExtensionPreferences(options.extensionPreferences);
      ensureOpen();
    }
    configuration = runtime.replaceResolvedConfig(options.mcpConfiguration);
    await configuration;
    ensureOpen();
  } catch (cause) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'MCP host startup and cleanup failed.');
    }
    throw cause;
  }
  const executableTools = (request: HostMcpToolRequest): Promise<HostMcpToolSelection> => {
    ensureOpen();
    // Capture the existing model and resilience selection before discovery
    // can overlap another run or a Settings change.
    const resolvedToolResultBudget = Object.freeze({ ...request.resolvedToolResultBudget });
    const toolTimeoutMs = request.toolTimeoutMs;
    let borrowedClient: McpRuntimeClient | undefined;
    let borrowedClosing: Promise<void> | undefined;
    const closeBorrow = (): Promise<void> => {
      borrowedClosing ??= Promise.resolve().then(async () => {
        if (borrowedClient) {
          await borrowedClient.disconnect();
          clients.delete(borrowedClient);
        }
      });
      return borrowedClosing;
    };
    const work = Promise.resolve()
      .then(async () => {
        ensureOpen();
        const before = runtime.host.snapshot();
        const client = await createMcpRuntimeClient({
          config: undefined,
          host: runtime.host,
          mcpTaskTracking: runtime.taskHost,
          toolTimeoutMs,
        });
        borrowedClient = client;
        if (client) {
          clients.add(client);
        }
        ensureOpen();
        const toolNameMap = new Map<string, string>();
        const collected = await options.collectCombinedTools({
          durableArtifactSettlement: false,
          mcpClient: client,
          mcpConfig: undefined,
          sanitizedLocalTools: undefined,
          scaledDefaultTokens: resolvedToolResultBudget.transportResultTokens,
          timeoutOverrideMs: undefined,
          toolNameMap,
        });
        ensureOpen();
        const after = runtime.host.snapshot();
        const bindings: Record<string, HostMcpToolSelection['bindings'][string]> = {};
        for (const [name, source] of Object.entries(collected.tools)) {
          bindings[name] = bindMcpTool({
            after,
            before,
            canonicalId: toolNameMap.get(name) ?? name,
            resolvedToolResultBudget,
            runtime,
            ...(request.snapshot ? { snapshot: request.snapshot } : {}),
            source,
            toolId: name,
            toolTimeoutMs,
          });
        }
        return Object.freeze({
          bindings: Object.freeze(bindings),
          close: closeBorrow,
          unavailable: unavailableServers(collected.mcpDiscoverySkips),
        });
      })
      .catch(async (cause: unknown) => {
        if (borrowedClient) {
          try {
            await closeBorrow();
          } catch (cleanup) {
            throw new AggregateError(
              [cause, cleanup],
              'MCP discovery and borrowed client cleanup failed.'
            );
          }
        }
        throw cause;
      });
    collections.add(work);
    const settled = (): void => {
      collections.delete(work);
    };
    work.then(settled, settled);
    return work;
  };
  return { close, mcp: { authority: runtime.host, close, executableTools }, runtime };
}
