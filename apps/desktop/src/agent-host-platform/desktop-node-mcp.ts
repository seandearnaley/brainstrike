import { collectCombinedTools } from '@brainstrike/agent/mcp-client';
import type { HostStartupContext } from '@brainstrike/agent-host';
import { parseMcpExtensionEnablement } from '@brainstrike/assistant-contract';
import { parseMcpConfigValue } from '@brainstrike/assistant-contract/mcp-config';
import type { McpTaskDatabase } from '@brainstrike/db';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { createSecretsMcpBearerCredentialAuthority } from '../mcp/bearer-credential';
import type { McpOAuthRecords, McpOAuthStore } from '../mcp/oauth-client-provider';
import { parseRecords } from '../mcp/oauth-client-provider';
import { createMcpHostServices, type McpHostServices } from './mcp-host-services';
import { applyMcpToolRegistryState, serveMcpRuntimeToMain } from './mcp-runtime-server';
import { MCP_STORE_METHODS, McpDesiredStateSchema } from './mcp-runtime-wire';

type Request = (method: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;

export class McpDiscoveryAdmissionError extends Error {
  readonly code = 'mcp-discovery-admission-failed';
  constructor() {
    super('Configured MCP tools could not be admitted');
    this.name = 'McpDiscoveryAdmissionError';
  }
}

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

/** The PGlite Tasks tables, still owned by Main's database host until host-owned storage. */
function remoteTaskDatabase(request: Request): McpTaskDatabase {
  const Rows = z.strictObject({ rows: z.array(z.unknown()) });
  return {
    query: async (sql, params) =>
      Rows.parse(await request(MCP_STORE_METHODS.tasksQuery, { params: params ?? [], sql })),
  };
}

/**
 * The desktop Node host owns the one MCP runtime. Host-thread MCP tools run
 * here, inside Core's process; Main reaches the same runtime for its renderer
 * surfaces. Credentials, config decryption, the Tasks tables and the external
 * opener stay behind narrow Main adapters until each store moves to Node.
 */
export async function createDesktopNodeMcpHost(
  connection: MessageConnection,
  request: Request,
  startup: Pick<HostStartupContext, 'signal'>
): Promise<{ readonly services: McpHostServices; close(): Promise<void> }> {
  const state = McpDesiredStateSchema.parse(await request(MCP_STORE_METHODS.state, {}));
  const services = await createMcpHostServices({
    appUi: 'rich',
    // Main asks for local presentation explicitly; until then local input fails closed.
    attachElicitationPresenter: () => () => undefined,
    bearerCredentialAuthority: createSecretsMcpBearerCredentialAuthority({
      getKey: async (key) =>
        z
          .string()
          .nullable()
          .parse(await request(MCP_STORE_METHODS.credentialRead, { key })),
      listProviders: async () =>
        z.array(z.string()).parse(await request(MCP_STORE_METHODS.credentialList, {})),
    }),
    collectCombinedTools,
    extensionPreferences: parseMcpExtensionEnablement(state.extensionPreferences),
    mcpConfiguration: parseMcpConfigValue(state.config).config,
    oauthStore: remoteOAuthStore(request),
    onMcpDiscoverySkips: async (skips) => {
      if (skips.length > 0) {
        throw new McpDiscoveryAdmissionError();
      }
    },
    openExternal: async (url) => {
      await request(MCP_STORE_METHODS.openExternal, { url });
    },
    openTaskDatabase: async () => remoteTaskDatabase(request),
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
