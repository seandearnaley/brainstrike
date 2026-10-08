import { resolve } from 'node:path';
import type {
  KeyringCredentialBackend,
  SecretsService,
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
import type { ProviderCredentialReader } from '@brainstrike/assistant-service/ports';
import { providerAuthInputFromCredential } from '@brainstrike/assistant-service/provider-credential-projection';
import { createSecretsMcpBearerCredentialAuthority } from './bearer-credential.js';
import type { AgentHostAdapterServices, AgentHostAdapterServicesOptions } from './contracts.js';
import { createCredentialMcpOAuthStore } from './credential-oauth-store.js';
import {
  AgentHostAdapterClosedError,
  createMcpHostServices,
  type McpHostCollector,
  type McpHostServices,
} from './mcp-host-services.js';
import type { AgentHostMcpCollection } from './mcp-tool-binding.js';
import type { McpHostRuntime } from './node-host-runtime.js';
import { identityKey, parseRecords } from './oauth-client-provider.js';

export {
  CredentialFileFormatError,
  createFileCredentialBackend,
  isMcpOAuthCredentialAccount,
} from '@brainstrike/agent-host/file-credentials';
export { AgentHostAdapterClosedError } from './mcp-host-services.js';
export { type AgentHostMcpCollection, bindMcpTool } from './mcp-tool-binding.js';

export interface AgentHostAdapterCapabilities<Collection extends AgentHostMcpCollection>
  extends McpHostCollector<Collection> {
  readonly createNativeCredentialBackend?: (service: string) => KeyringCredentialBackend;
  /** Bind the canonical provider resolver to this same Settings credential authority. */
  readonly createProviderCredentialReader: (secrets: SecretsService) => ProviderCredentialReader;
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
    let services: McpHostServices | undefined;
    let closing: Promise<void> | undefined;
    const ensureOpen = (): void => {
      options.startup.signal.throwIfAborted();
      if (closing) {
        throw new AgentHostAdapterClosedError();
      }
    };
    const close = (): Promise<void> => {
      closing ??= Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        if (services) {
          try {
            const report = await services.close();
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
      services = await createMcpHostServices({
        appUi: options.appUi,
        attachElicitationPresenter: capabilities.attachElicitationPresenter,
        bearerCredentialAuthority: createSecretsMcpBearerCredentialAuthority(secrets),
        collectCombinedTools: capabilities.collectCombinedTools,
        isClosing: () => closing !== undefined,
        mcpConfiguration: options.mcpConfiguration,
        oauthStore: oauth,
        openExternal: options.openExternal,
        openTaskDatabase: options.openTaskDatabase,
        ...(capabilities.runtimeDependencies
          ? { runtimeDependencies: capabilities.runtimeDependencies }
          : {}),
        startup: options.startup,
      });
      ensureOpen();
      const reader = capabilities.createProviderCredentialReader(settingsSecrets);
      const readProviderCredential: ProviderCredentialReader = (provider) =>
        guarded(() => reader(provider));
      return {
        close,
        mcp: services.mcp,
        readProviderCredential,
        resolveProviderAuth: async (provider) =>
          providerAuthInputFromCredential(
            provider,
            await readProviderCredential(provider),
            options.authProjectionOptions
          ),
        runtime: services.runtime,
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
