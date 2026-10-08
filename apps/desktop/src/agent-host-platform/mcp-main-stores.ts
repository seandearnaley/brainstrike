import {
  MCP_CREDENTIAL_KEY_PREFIX,
  MCP_STORE_METHODS,
  McpCredentialKeySchema,
  McpOAuthIdentitySchema,
  respond,
} from '@brainstrike/host-capabilities/mcp/mcp-runtime-wire';
import type { McpOAuthStore } from '@brainstrike/host-capabilities/mcp/oauth-client-provider';
import { parseRecords } from '@brainstrike/host-capabilities/mcp/oauth-client-provider';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import type { RemoteMcpRuntime } from '../mcp/remote-runtime';

/** Main's MCP stores that still need Electron or Main's database host (c1 interim). */
export interface DesktopMcpPlatformCapabilities {
  listCredentials(): Promise<readonly string[]>;
  readonly oauth: McpOAuthStore;
  openExternal(url: string): Promise<void>;
  queryTasks(sql: string, params: readonly unknown[]): Promise<{ readonly rows: unknown[] }>;
  readCredential(key: string): Promise<string | null>;
  readonly runtime: RemoteMcpRuntime;
}

function tokenSignal(token: CancellationToken): AbortSignal {
  const controller = new AbortController();
  token.onCancellationRequested(() =>
    controller.abort(new DOMException('Cancelled', 'AbortError'))
  );
  if (token.isCancellationRequested) {
    controller.abort(new DOMException('Cancelled', 'AbortError'));
  }
  return controller.signal;
}

/**
 * Serve the Node MCP runtime's store adapters and bind Main's runtime proxy to
 * this host connection. Each adapter is removed when its store moves to Node:
 * credentials with the keyring migration, the Tasks tables with host-owned
 * storage, config with host-owned config, the opener stays a narrow adapter.
 */
export function serveMainMcpStores(
  connection: MessageConnection,
  capabilities: DesktopMcpPlatformCapabilities
): { close(): void } {
  const binding = capabilities.runtime.bind(connection);
  const handlers = [
    connection.onRequest(MCP_STORE_METHODS.state, () =>
      respond(() => capabilities.runtime.desiredState())
    ),
    connection.onRequest(MCP_STORE_METHODS.ready, (input: unknown) =>
      respond(() =>
        binding.ready(
          z.strictObject({ revision: z.number().int().nonnegative() }).parse(input).revision
        )
      )
    ),
    connection.onRequest(MCP_STORE_METHODS.openExternal, (input: unknown) =>
      respond(() => capabilities.openExternal(z.strictObject({ url: z.url() }).parse(input).url))
    ),
    connection.onRequest(MCP_STORE_METHODS.tasksQuery, (input: unknown) =>
      respond(async () => {
        const request = z
          .strictObject({ params: z.array(z.json()), sql: z.string().min(1) })
          .parse(input);
        const result = await capabilities.queryTasks(request.sql, request.params);
        return { rows: result.rows };
      })
    ),
    connection.onRequest(MCP_STORE_METHODS.credentialRead, (input: unknown) =>
      respond(() =>
        capabilities.readCredential(
          McpCredentialKeySchema.parse(z.strictObject({ key: z.string() }).parse(input).key)
        )
      )
    ),
    connection.onRequest(MCP_STORE_METHODS.credentialList, () =>
      respond(async () =>
        (await capabilities.listCredentials()).filter((key) =>
          key.startsWith(MCP_CREDENTIAL_KEY_PREFIX)
        )
      )
    ),
    connection.onRequest(MCP_STORE_METHODS.oauthRead, (input: unknown, token: CancellationToken) =>
      respond(() =>
        capabilities.oauth.read(
          McpOAuthIdentitySchema.parse(
            z.strictObject({ identity: z.unknown() }).parse(input).identity
          ),
          tokenSignal(token)
        )
      )
    ),
    connection.onRequest(MCP_STORE_METHODS.oauthWrite, (input: unknown, token: CancellationToken) =>
      respond(async () => {
        const request = z
          .strictObject({ identity: McpOAuthIdentitySchema, records: z.json() })
          .parse(input);
        // The shipped validator reads the persisted JSON text before Main stores it.
        await capabilities.oauth.write(
          request.identity,
          parseRecords(JSON.stringify(request.records)),
          tokenSignal(token)
        );
      })
    ),
    connection.onRequest(MCP_STORE_METHODS.oauthClear, (input: unknown, token: CancellationToken) =>
      respond(async () => {
        const request = z.strictObject({ identity: McpOAuthIdentitySchema }).parse(input);
        await capabilities.oauth.clear(request.identity, tokenSignal(token));
      })
    ),
    connection.onRequest(
      MCP_STORE_METHODS.oauthClearAll,
      (_input: unknown, token: CancellationToken) =>
        respond(async () => {
          await capabilities.oauth.clearAll(tokenSignal(token));
        })
    ),
  ];
  return {
    close: () => {
      binding.close();
      for (const handler of handlers) {
        handler.dispose();
      }
    },
  };
}
