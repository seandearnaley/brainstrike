import { resolve } from 'node:path';
import { createMcpRuntimeClient, type McpRuntimeClient } from '@brainstrike/agent/mcp-client';
import {
  guardToolExecution,
  type RuntimeData,
  type ScaledToolResultBudget,
} from '@brainstrike/agent/tool-runtime';
import {
  assertMcpAuthorityReconstruction,
  type HostMcpToolRequest,
  type HostMcpToolSelection,
} from '@brainstrike/agent-host';
import {
  joinCredentialCleanup,
  type KeyringCredentialBackend,
  type SecretsService,
} from '@brainstrike/agent-host/credential-contract';
import {
  createFileCredentialBackend,
  isMcpOAuthCredentialAccount,
} from '@brainstrike/agent-host/file-credentials';
import {
  createKeyringCredentialStore,
  createKeyringSecretsService,
} from '@brainstrike/agent-host/keyring-credentials';
import { createKeyringCredentialBackend } from '@brainstrike/agent-host/keyring-native';
import type { HostRunSnapshot } from '@brainstrike/agent-host/protocol';
import type { McpHostCloseReport, McpHostSnapshot } from '@brainstrike/assistant-contract';
import type { ProviderCredentialReader } from '@brainstrike/assistant-service/ports';
import { providerAuthInputFromCredential } from '@brainstrike/assistant-service/provider-credential-projection';
import { createAgentHostToolBindings } from '../agent-host-tool-bindings';
import { createSecretsMcpBearerCredentialAuthority } from '../mcp/bearer-credential';
import { createCredentialMcpOAuthStore } from '../mcp/credential-oauth-store';
import { McpHostRuntime, type McpHostRuntimeDependencies } from '../mcp/node-host-runtime';
import { identityKey, parseRecords } from '../mcp/oauth-client-provider';
import type { AgentHostAdapterServices, AgentHostAdapterServicesOptions } from './contracts';
import { type McpElicitationDisplaySurface, McpHostInputRelay } from './mcp-input-relay';

export {
  CredentialFileFormatError,
  createFileCredentialBackend,
  isMcpOAuthCredentialAccount,
} from '@brainstrike/agent-host/file-credentials';

type CanonicalTools = NonNullable<RuntimeData['mastraTools']>;
type ExecutableMcpBindings = HostMcpToolSelection['bindings'];

export function bindMcpTool(options: {
  readonly after: McpHostSnapshot;
  readonly before: McpHostSnapshot;
  readonly canonicalId: string;
  readonly resolvedToolResultBudget: ScaledToolResultBudget;
  readonly source: CanonicalTools[string];
  readonly runtime: McpHostRuntime;
  readonly snapshot?: HostRunSnapshot;
  readonly toolId: string;
  readonly toolTimeoutMs: number;
}): ExecutableMcpBindings[string] {
  const { after, before, canonicalId, source } = options;
  // Match the collector's existing dotted namespace to exact catalog entries;
  // routing never parses an arbitrary model-provided name.
  const owners = after.servers.filter(
    (server) =>
      server.state === 'connected' &&
      server.catalog?.tools?.tools.some(
        (tool) => `${server.configuredServerId}.${tool.name}` === canonicalId
      )
  );
  const owner = owners[0];
  if (
    owners.length !== 1 ||
    !owner ||
    !before.servers.some(
      (server) =>
        server.configuredServerId === owner.configuredServerId &&
        server.generation === owner.generation
    )
  ) {
    throw new Error('MCP discovery no longer belongs to one configured server generation.');
  }
  if (!('id' in source && typeof source.id === 'string')) {
    throw new Error('MCP collector returned no canonical executor identity.');
  }
  const identity = JSON.stringify([owner.configuredServerId, owner.generation, source.id]);
  const mcpAuthority = options.runtime.describeToolAuthority(
    owner.configuredServerId,
    owner.generation
  );
  if (options.snapshot) {
    assertMcpAuthorityReconstruction(
      options.snapshot.mcpAuthorities?.[options.toolId],
      mcpAuthority
    );
  }
  const bound = createAgentHostToolBindings({
    bindings: { [canonicalId]: { identity, risk: 'mcp' } },
    resolvedToolResultBudget: options.resolvedToolResultBudget,
    tools: {
      [canonicalId]: guardToolExecution(source, {
        timeoutMs: options.toolTimeoutMs,
        toolName: canonicalId,
      }),
    },
  });
  const tool = Object.values(bound.tools)[0];
  if (!tool) {
    throw new Error('MCP collector returned no executable binding.');
  }
  return {
    configuredServerId: owner.configuredServerId,
    generation: owner.generation,
    tool: { ...tool, mcpAuthority },
  };
}

export class AgentHostAdapterClosedError extends Error {
  readonly code = 'agent_host_adapter_closed';
  constructor() {
    super('Agent host adapter services are closing.');
    this.name = 'AgentHostAdapterClosedError';
  }
}

/** Structural injection of the shipped collector, until its public barrel is available. */
export interface AgentHostMcpCollection {
  readonly mcpDiscoverySkips: readonly unknown[];
  readonly tools: CanonicalTools;
}

export interface AgentHostAdapterCapabilities<Collection extends AgentHostMcpCollection> {
  /**
   * Attach a local display of MCP server input. The agent host's Core is the
   * consent surface: a display sees input only after Core committed it, and
   * clients answer through the host protocol.
   */
  readonly attachElicitationPresenter: (presenter: McpElicitationDisplaySurface) => () => void;
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
  readonly createNativeCredentialBackend?: (service: string) => KeyringCredentialBackend;
  /** Bind the canonical provider resolver to this same Settings credential authority. */
  readonly createProviderCredentialReader: (secrets: SecretsService) => ProviderCredentialReader;
  /** Publish through the owning host dispatcher, before admission returns. */
  readonly onMcpDiscoverySkips: (skips: Collection['mcpDiscoverySkips']) => Promise<void>;
  readonly runtimeDependencies?: McpHostRuntimeDependencies;
}

/** Process-local Settings, Apps, Tasks and elicitation ports all borrow this runtime. */
export interface ComposedAgentHostAdapterServices extends AgentHostAdapterServices {
  readonly runtime: McpHostRuntime;
  readonly secrets: SecretsService;
}

/**
 * Bind the canonical policy capabilities once, then pass the returned factory
 * directly to the published CreateAgentHostAdapterServices composition port.
 * No desktop defaults, SDK transport authority or database writer is recreated.
 */
export function createAgentHostAdapterServicesFactory<Collection extends AgentHostMcpCollection>(
  capabilities: AgentHostAdapterCapabilities<Collection>
): (options: AgentHostAdapterServicesOptions) => Promise<ComposedAgentHostAdapterServices> {
  return async (options) => {
    let credentials: ReturnType<typeof createKeyringCredentialStore> | undefined;
    let oauth: ReturnType<typeof createCredentialMcpOAuthStore> | undefined;
    let runtime: McpHostRuntime | undefined;
    let configuration: Promise<unknown> | undefined;
    let detachElicitation: (() => void) | undefined;
    let mcpInput: McpHostInputRelay | undefined;
    const clients = new Set<McpRuntimeClient>();
    const collections = new Set<Promise<HostMcpToolSelection>>();
    let closing: Promise<void> | undefined;
    let mcpClosing: Promise<McpHostCloseReport> | undefined;
    const ensureOpen = (): void => {
      options.startup.signal.throwIfAborted();
      if (closing || mcpClosing) {
        throw new AgentHostAdapterClosedError();
      }
    };
    const closeMcp = (): Promise<McpHostCloseReport> => {
      mcpClosing ??= Promise.resolve().then(async () => {
        let report: McpHostCloseReport | undefined;
        // The shared authority joins actual requests, Tasks and OAuth persistence.
        // A discovery timeout or caller abort is never treated as that receipt.
        await joinCredentialCleanup(
          [
            ...[...clients].map((client) => client.disconnect()),
            Promise.resolve().then(async () => {
              report = await runtime?.host.close();
            }),
          ],
          'Agent host MCP adapter cleanup failed.',
          () => [
            Promise.allSettled([configuration, ...collections]).then(async () => {
              // A borrowed client can finish acquisition after shutdown starts.
              await joinCredentialCleanup(
                [
                  ...[...clients].map((client) => client.disconnect()),
                  Promise.resolve().then(() => {
                    detachElicitation?.();
                    mcpInput?.close();
                  }),
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
      return mcpClosing;
    };
    const close = (): Promise<void> => {
      closing ??= Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        if (runtime) {
          try {
            const report = await closeMcp();
            failures.push(...report.failures);
          } catch (cause) {
            failures.push(cause);
          }
        }
        // Allow runtime cleanup writes first; then fence and physically join the
        // raw credential lane, including an unsignalled native worker's exit.
        try {
          await credentials?.close();
        } catch (cause) {
          failures.push(cause);
        } finally {
          oauth?.unregister();
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Agent host adapter cleanup failed.');
        }
      });
      return closing;
    };
    // Registration precedes native worker creation, OAuth registration, file
    // mutation, transport startup and the borrowed Tasks database capability.
    await options.startup.register(close);
    try {
      ensureOpen();
      const selection = options.credentialStore;
      credentials = createKeyringCredentialStore({
        backend:
          selection.kind === 'file'
            ? createFileCredentialBackend(selection.path)
            : (capabilities.createNativeCredentialBackend ?? createKeyringCredentialBackend)(
                selection.service
              ),
        service: selection.kind === 'file' ? resolve(selection.path) : selection.service,
      });
      const secrets = createKeyringSecretsService({
        accountForProvider: (provider) => provider,
        credentials,
        providerForAccount: (account) =>
          isMcpOAuthCredentialAccount(account) ? undefined : account,
      });
      const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
        ensureOpen();
        const value = await operation();
        ensureOpen();
        return value;
      };
      // Settings and provider callers stop admitting work immediately. Runtime
      // cleanup retains the same underlying authority until its final writes join.
      const settingsSecrets: SecretsService = {
        clearAll: () => guarded(() => secrets.clearAll()),
        deleteKey: (provider) => guarded(() => secrets.deleteKey(provider)),
        getCredential: (provider) => guarded(() => secrets.getCredential(provider)),
        getKey: (provider) => guarded(() => secrets.getKey(provider)),
        listProviders: () => guarded(() => secrets.listProviders()),
        saveKey: (provider, value) => guarded(() => secrets.saveKey(provider, value)),
        setCredential: (provider, credential) =>
          guarded(() => secrets.setCredential(provider, credential)),
      };
      oauth = createCredentialMcpOAuthStore({
        accountForIdentity: identityKey,
        credentials,
        ownsAccount: isMcpOAuthCredentialAccount,
        parseRecords,
      });
      const authority = new McpHostRuntime(
        {
          appUi: options.appUi,
          bearerCredentialAuthority: createSecretsMcpBearerCredentialAuthority(secrets),
          oauthStore: oauth,
          openExternal: options.openExternal,
          openTaskDatabase: options.openTaskDatabase,
        },
        capabilities.runtimeDependencies
      );
      runtime = authority;
      mcpInput = new McpHostInputRelay(authority.elicitationPresenter);
      detachElicitation = capabilities.attachElicitationPresenter(mcpInput.surface);
      const reader = capabilities.createProviderCredentialReader(settingsSecrets);
      const readProviderCredential: ProviderCredentialReader = (provider) =>
        guarded(() => reader(provider));
      configuration = authority.replaceResolvedConfig(options.mcpConfiguration);
      await configuration;
      ensureOpen();
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
            const before = authority.host.snapshot();
            const client = await createMcpRuntimeClient({
              config: undefined,
              host: authority.host,
              mcpTaskTracking: authority.taskHost,
              toolTimeoutMs,
            });
            borrowedClient = client;
            if (client) {
              clients.add(client);
            }
            ensureOpen();
            const toolNameMap = new Map<string, string>();
            const collected = await capabilities.collectCombinedTools({
              durableArtifactSettlement: false,
              mcpClient: client,
              mcpConfig: undefined,
              sanitizedLocalTools: undefined,
              scaledDefaultTokens: resolvedToolResultBudget.transportResultTokens,
              timeoutOverrideMs: undefined,
              toolNameMap,
            });
            ensureOpen();
            await capabilities.onMcpDiscoverySkips(collected.mcpDiscoverySkips);
            ensureOpen();
            const after = authority.host.snapshot();
            const bindings: Record<string, ExecutableMcpBindings[string]> = {};
            for (const [name, source] of Object.entries(collected.tools)) {
              bindings[name] = bindMcpTool({
                after,
                before,
                canonicalId: toolNameMap.get(name) ?? name,
                resolvedToolResultBudget,
                runtime: authority,
                ...(request.snapshot ? { snapshot: request.snapshot } : {}),
                source,
                toolId: name,
                toolTimeoutMs,
              });
            }
            return Object.freeze({ bindings: Object.freeze(bindings), close: closeBorrow });
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
      return {
        close,
        mcp: { authority: authority.host, close: closeMcp, executableTools, input: mcpInput },
        readProviderCredential,
        resolveProviderAuth: async (provider) =>
          providerAuthInputFromCredential(
            provider,
            await readProviderCredential(provider),
            options.authProjectionOptions
          ),
        runtime: authority,
        secrets: settingsSecrets,
      };
    } catch (cause) {
      try {
        await close();
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          'Agent host adapter startup and cleanup failed.'
        );
      }
      throw cause;
    }
  };
}
