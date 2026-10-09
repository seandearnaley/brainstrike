import { collectCombinedTools } from '@brainstrike/agent/mcp-client';
import type { HostStartupContext } from '@brainstrike/agent-host';
import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import { parseMcpExtensionEnablement } from '@brainstrike/assistant-contract';
import { parseMcpConfigValue } from '@brainstrike/assistant-contract/mcp-config';
import type { MessageConnection } from 'vscode-jsonrpc';
import { createSecretsMcpBearerCredentialAuthority } from './bearer-credential.js';
import { importLegacyMcpTasks } from './legacy-task-import.js';
import { createMcpHostServices, type McpHostServices } from './mcp-host-services.js';

import { applyMcpToolRegistryState, serveMcpRuntimeToMain } from './mcp-runtime-server.js';
import { MCP_STORE_METHODS, McpDesiredStateSchema } from './mcp-runtime-wire.js';
import type { McpOAuthRecords, McpOAuthStore } from './oauth-client-provider.js';
import { parseRecords } from './oauth-client-provider.js';
import { stateStoreMcpTaskStorage } from './state-store-task-storage.js';

type Request = (method: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;

/** The safeStorage OAuth store, still owned by Main until the keyring migration. */
function remoteOAuthStore(request: Request): McpOAuthStore {
  return {
    clear: async (identity, signal) => {
      await request(MCP_STORE_METHODS.oauthClear, { identity }, signal);
    },
    clearAll: async (signal) => {
      await request(MCP_STORE_METHODS.oauthClearAll, {}, signal);
    },
    // The shipped validator reads the persisted JSON text, exactly as Main's store does.
    read: async (identity, signal): Promise<McpOAuthRecords> =>
      parseRecords(
        JSON.stringify(await request(MCP_STORE_METHODS.oauthRead, { identity }, signal))
      ),
    write: async (identity, records, signal) => {
      await request(MCP_STORE_METHODS.oauthWrite, { identity, records }, signal);
    },
  };
}

/**
 * The desktop Node host owns the one MCP runtime. Host-thread MCP tools run
 * here, inside Core's process; Main reaches the same runtime for its renderer
 * surfaces. Its Tasks live in the host's StateStore; config decryption, OAuth
 * records and the external opener stay behind narrow Main adapters until each
 * store moves to Node.
 */
export async function createDesktopNodeMcpHost(
  connection: MessageConnection,
  request: Request,
  startup: Pick<HostStartupContext, 'signal' | 'store'>,
  /** The profile credential store Main and this host share (MCP bearer references). */
  secrets: () => Pick<SecretsService, 'getKey' | 'listProviders'>
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
  const services = await createMcpHostServices({
    appUi: 'rich',
    // Main asks for local presentation explicitly; until then local input fails closed.
    attachElicitationPresenter: () => () => undefined,
    bearerCredentialAuthority: createSecretsMcpBearerCredentialAuthority({
      getKey: (key) => secrets().getKey(key),
      listProviders: () => secrets().listProviders(),
    }),
    collectCombinedTools,
    extensionPreferences: parseMcpExtensionEnablement(state.extensionPreferences),
    mcpConfiguration: parseMcpConfigValue(state.config).config,
    oauthStore: remoteOAuthStore(request),
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
  let server: ReturnType<typeof serveMcpRuntimeToMain> | undefined;
  try {
    applyMcpToolRegistryState(state.tools);
    server = serveMcpRuntimeToMain(connection, services.runtime);
    await request(MCP_STORE_METHODS.ready, { revision: state.revision });
  } catch (cause) {
    server?.close();
    try {
      await services.close();
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
        const report = await services.close();
        if (report.failures.length > 0) {
          throw new AggregateError(report.failures, 'Desktop MCP host cleanup failed');
        }
      })()),
    services,
  };
}
