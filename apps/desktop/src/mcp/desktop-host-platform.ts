import type { McpTaskDatabase } from '@brainstrike/db';
import type { DesktopMcpPlatformCapabilities } from '../agent-host-platform/mcp-main-stores';
import {
  createSecretsMcpBearerCredentialAuthority,
  type McpBearerCredentialAuthority,
} from './bearer-credential';
import type { McpHostRuntimePlatform } from './node-host-runtime';
import { createLazySafeStorageMcpOAuthStore, type McpOAuthStore } from './oauth-client-provider';
import { openExternalWithElectron } from './open-external';
import type { RemoteMcpRuntime } from './remote-runtime';

export interface DesktopMcpHostPlatformDependencies {
  readonly bearerCredentialAuthority?: McpBearerCredentialAuthority;
  readonly oauthStore?: McpOAuthStore;
  readonly openExternal?: (url: string) => Promise<void>;
}

function createDefaultBearerCredentialAuthority(): McpBearerCredentialAuthority {
  let authority: Promise<McpBearerCredentialAuthority> | undefined;
  const load = (): Promise<McpBearerCredentialAuthority> => {
    authority ??= import('../secrets').then(({ getSecretsService }) =>
      createSecretsMcpBearerCredentialAuthority(getSecretsService())
    );
    return authority;
  };
  return {
    createFetch(reference, resourceUrl, onStateChanged) {
      return async (input, init) =>
        await (await load()).createFetch(reference, resourceUrl, onStateChanged)(input, init);
    },
    async inspect(reference) {
      return await (await load()).inspect(reference);
    },
  };
}

function createDefaultOAuthStore(): McpOAuthStore {
  return createLazySafeStorageMcpOAuthStore(async () => {
    const { createDefaultSafeStorageMcpOAuthStore } = await import('./oauth-safe-storage-defaults');
    return createDefaultSafeStorageMcpOAuthStore();
  });
}

function createDefaultTaskDatabaseOpener(): () => Promise<McpTaskDatabase> {
  return async () => {
    const { getDatabase } = await import('../db-main');
    const database = await getDatabase();
    return { query: (sql, params) => database.query(sql, params) };
  };
}

/** Only desktop composition may select Electron-backed stores, opener and database. */
export function createDesktopMcpHostPlatform(
  dependencies: DesktopMcpHostPlatformDependencies = {}
): McpHostRuntimePlatform {
  return {
    appUi: 'rich',
    bearerCredentialAuthority:
      dependencies.bearerCredentialAuthority ?? createDefaultBearerCredentialAuthority(),
    oauthStore: dependencies.oauthStore ?? createDefaultOAuthStore(),
    openExternal: dependencies.openExternal ?? openExternalWithElectron,
    openTaskDatabase: createDefaultTaskDatabaseOpener(),
  };
}

let mainOAuthStore: McpOAuthStore | undefined;

/**
 * Main's MCP stores for the Node host's runtime (BST-1930 c1 interim): the
 * safeStorage credentials and OAuth records, the PGlite Tasks tables and
 * Electron's external opener. One OAuth store serves every host fork, so the
 * "clear all secrets" purge reaches the same registered store.
 */
export function createDesktopMcpPlatformCapabilities(
  runtime: RemoteMcpRuntime
): DesktopMcpPlatformCapabilities {
  mainOAuthStore ??= createDefaultOAuthStore();
  const secrets = async () => {
    const { getSecretsService } = await import('../secrets');
    return getSecretsService();
  };
  return {
    listCredentials: async () => await (await secrets()).listProviders(),
    oauth: mainOAuthStore,
    openExternal: openExternalWithElectron,
    queryTasks: async (sql, params) => {
      const { getDatabase } = await import('../db-main');
      const result = await (await getDatabase()).query(sql, [...params]);
      return { rows: [...result.rows] };
    },
    readCredential: async (key) => await (await secrets()).getKey(key),
    runtime,
  };
}
