import { collectCombinedTools } from '@brainstrike/agent/mcp-client';
import type { HostStartupContext } from '@brainstrike/agent-host';
import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import { isMcpOAuthCredentialAccount } from '@brainstrike/agent-host/file-credentials';
import { parseMcpExtensionEnablement } from '@brainstrike/assistant-contract';
import { parseMcpConfigValue } from '@brainstrike/assistant-contract/mcp-config';
import type { MessageConnection } from 'vscode-jsonrpc';
import { createSecretsMcpBearerCredentialAuthority } from './bearer-credential.js';
import {
  createCredentialMcpOAuthStore,
  type McpOAuthCredentialStorage,
} from './credential-oauth-store.js';
import { importLegacyMcpTasks } from './legacy-task-import.js';
import { createMcpHostServices, type McpHostServices } from './mcp-host-services.js';

import { applyMcpToolRegistryState, serveMcpRuntimeToMain } from './mcp-runtime-server.js';
import { MCP_STORE_METHODS, McpDesiredStateSchema } from './mcp-runtime-wire.js';
import { identityKey, parseRecords } from './oauth-client-provider.js';
import { stateStoreMcpTaskStorage } from './state-store-task-storage.js';

type Request = (method: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;

/** The profile credential store Main and this host share. */
export interface DesktopNodeMcpCredentials {
  /** MCP bearer references, behind the host's credential gate. */
  secrets(): Pick<SecretsService, 'getKey' | 'listProviders'>;
  /** The raw accounts: this host is the one writer of its MCP OAuth records. */
  store(): McpOAuthCredentialStorage;
}

/**
 * The desktop Node host owns the one MCP runtime. Host-thread MCP tools run
 * here, inside Core's process; Main reaches the same runtime for its renderer
 * surfaces. Its Tasks live in the host's StateStore and its OAuth records in
 * the profile credential store, under their 64-hex identity accounts. Config
 * decryption and the external opener stay behind narrow Main adapters.
 */
export async function createDesktopNodeMcpHost(
  connection: MessageConnection,
  request: Request,
  startup: Pick<HostStartupContext, 'signal' | 'store'>,
  credentials: DesktopNodeMcpCredentials
): Promise<{ readonly services: McpHostServices; close(): Promise<void> }> {
  const state = McpDesiredStateSchema.parse(await request(MCP_STORE_METHODS.state, {}));
  const taskStorage = stateStoreMcpTaskStorage(startup.store);
  // Tasks storage opens only after Main's legacy PGlite rows are imported; a
  // failed import refuses this open and the next open retries it.
  let imported: Promise<void> | undefined;
  const importLegacyTasks = (): Promise<void> =>
    (imported ??= importLegacyMcpTasks(startup.store, () =>
      request(MCP_STORE_METHODS.tasksLegacy, {})
    ).catch((cause: unknown) => {
      imported = undefined;
      throw cause;
    }));
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
      extensionPreferences: parseMcpExtensionEnablement(state.extensionPreferences),
      mcpConfiguration: parseMcpConfigValue(state.config).config,
      oauthStore,
      openExternal: async (url) => {
        await request(MCP_STORE_METHODS.openExternal, { url });
      },
      // The host's StateStore is the one MCP Tasks writer.
      openTaskStorage: async () => {
        await importLegacyTasks();
        return taskStorage;
      },
      startup,
    });
  } catch (cause) {
    oauthStore.unregister();
    throw cause;
  }
  let server: ReturnType<typeof serveMcpRuntimeToMain> | undefined;
  try {
    applyMcpToolRegistryState(state.tools);
    server = serveMcpRuntimeToMain(connection, services.runtime);
    await request(MCP_STORE_METHODS.ready, { revision: state.revision });
  } catch (cause) {
    server?.close();
    try {
      await closeServices(services);
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Desktop MCP host startup and cleanup failed');
    }
    throw cause;
  }
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= (async () => {
        server?.close();
        const report = await closeServices(services);
        if (report.failures.length > 0) {
          throw new AggregateError(report.failures, 'Desktop MCP host cleanup failed');
        }
      })()),
    services,
  };
}
