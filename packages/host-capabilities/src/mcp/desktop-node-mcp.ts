import { collectCombinedTools } from '@brainstrike/agent/mcp-client';
import type { HostStartupContext } from '@brainstrike/agent-host';
import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import { isMcpOAuthCredentialAccount } from '@brainstrike/agent-host/file-credentials';
import { createLogger } from '@brainstrike/logging';
import type { MessageConnection } from 'vscode-jsonrpc';
import { createSecretsMcpBearerCredentialAuthority } from './bearer-credential.js';
import { createMcpConfigFile } from './config-file.js';
import {
  createCredentialMcpOAuthStore,
  type McpOAuthCredentialStorage,
} from './credential-oauth-store.js';
import { readStoredMcpExtensionPreferences } from './extension-preferences.js';
import { createMcpHostServices, type McpHostServices } from './mcp-host-services.js';
import { serveMcpRuntimeToMain } from './mcp-runtime-server.js';
import { MCP_STORE_METHODS } from './mcp-runtime-wire.js';
import { identityKey, parseRecords } from './oauth-client-provider.js';
import { McpSettingsAuthority } from './settings-authority.js';
import { stateStoreMcpTaskStorage } from './state-store-task-storage.js';

const logger = createLogger('DesktopNodeMcpHost');

type Request = (method: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;

/** The profile credential store Main and this host share. */
export interface DesktopNodeMcpCredentials {
  /** MCP bearer references, behind the host's credential gate. */
  secrets(): Pick<SecretsService, 'getKey' | 'listProviders'>;
  /** The raw accounts: this host is the one writer of its MCP OAuth records. */
  store(): McpOAuthCredentialStorage;
}

export interface DesktopNodeMcpHostOptions {
  readonly connection: MessageConnection;
  readonly credentials: DesktopNodeMcpCredentials;
  /** Requests to Main over the private platform connection. */
  readonly request: Request;
  readonly startup: Pick<HostStartupContext, 'signal' | 'store'>;
  /** The desktop profile: `mcp/` holds its config and tool preferences. */
  readonly userDataDir: string;
}

export interface DesktopNodeMcpHost {
  close(): Promise<void>;
  readonly services: McpHostServices;
  /** The profile's MCP settings: config file, extension dials and tool preferences. */
  readonly settings: McpSettingsAuthority;
}

/**
 * The desktop Node host owns the one MCP runtime and its settings. Host-thread
 * MCP tools run here, inside Core's process; Main reaches the same runtime for
 * its remaining renderer surfaces. Its config and tool preferences live in the
 * profile's `mcp/` directory, its extension dials and Tasks in the host's
 * StateStore, its OAuth records in the profile credential store under their
 * 64-hex identity accounts. Only the external opener and the native config
 * picker stay behind narrow Main adapters.
 */
export async function createDesktopNodeMcpHost(
  options: DesktopNodeMcpHostOptions
): Promise<DesktopNodeMcpHost> {
  const { connection, credentials, request, startup, userDataDir } = options;
  const taskStorage = stateStoreMcpTaskStorage(startup.store);
  // The stored opt-out applies before any server hears what this client supports.
  const extensions = await readStoredMcpExtensionPreferences(startup.store);
  // Created eagerly, so the host's factory reset reaches its records before any connect.
  const oauthStore = createCredentialMcpOAuthStore({
    accountForIdentity: identityKey,
    credentials: credentials.store(),
    ownsAccount: isMcpOAuthCredentialAccount,
    parseRecords,
  });
  // The runtime's last OAuth writes join before the reset registration goes.
  const closeServices = async (owned: McpHostServices) => {
    try {
      return await owned.close();
    } finally {
      try {
        await oauthStore.join();
      } finally {
        oauthStore.unregister();
      }
    }
  };
  let services: McpHostServices;
  try {
    services = await createMcpHostServices({
      appUi: 'rich',
      // Main asks for local presentation explicitly; until then local input fails closed.
      attachElicitationPresenter: () => () => undefined,
      bearerCredentialAuthority: createSecretsMcpBearerCredentialAuthority({
        getKey: (key) => credentials.secrets().getKey(key),
        listProviders: () => credentials.secrets().listProviders(),
      }),
      collectCombinedTools,
      extensionPreferences: extensions.preferences,
      // The settings authority loads the profile's config once it starts.
      mcpConfiguration: { servers: [] },
      oauthStore,
      openExternal: async (url) => {
        await request(MCP_STORE_METHODS.openExternal, { url });
      },
      // The host's StateStore is the one MCP Tasks writer.
      openTaskStorage: async () => taskStorage,
      startup,
    });
  } catch (cause) {
    oauthStore.unregister();
    throw cause;
  }
  const settings = new McpSettingsAuthority({
    configFile: createMcpConfigFile(userDataDir),
    extensionStore: startup.store,
    runtime: services.runtime,
    userDataDir,
  });
  let server: ReturnType<typeof serveMcpRuntimeToMain> | undefined;
  try {
    server = serveMcpRuntimeToMain(connection, services.runtime, settings);
    await request(MCP_STORE_METHODS.ready, {});
  } catch (cause) {
    server?.close();
    try {
      await settings.close();
      await closeServices(services);
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Desktop MCP host startup and cleanup failed');
    }
    throw cause;
  }
  // Config load and discovery reach servers over the network: host readiness never
  // waits for them. Settings requests queue behind this start on its lifecycle.
  void settings.start().catch((error: unknown) => {
    logger.error('MCP settings startup failed', { error });
  });
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= (async () => {
        server?.close();
        const failures: unknown[] = [];
        try {
          await settings.close();
        } catch (cause) {
          failures.push(cause);
        }
        const report = await closeServices(services);
        failures.push(...report.failures);
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Desktop MCP host cleanup failed');
        }
      })()),
    services,
    settings,
  };
}
