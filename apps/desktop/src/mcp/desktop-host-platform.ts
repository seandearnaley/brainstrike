import { type McpTaskStorage, pgliteMcpTaskStorage } from '@brainstrike/db';
import {
  createSecretsMcpBearerCredentialAuthority,
  type McpBearerCredentialAuthority,
} from '@brainstrike/host-capabilities/mcp/bearer-credential';
import type { McpHostRuntimePlatform } from '@brainstrike/host-capabilities/mcp/node-host-runtime';
import {
  createLazySafeStorageMcpOAuthStore,
  type McpOAuthStore,
} from '@brainstrike/host-capabilities/mcp/oauth-client-provider';
import type { DesktopMcpPlatformCapabilities } from '../agent-host-platform/mcp-main-stores';
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

/** The conformance client's own process: the PGlite Tasks tables of its profile. */
function createDefaultTaskStorageOpener(): () => Promise<McpTaskStorage> {
  return async () => {
    const { getDatabase } = await import('../db-main');
    const database = await getDatabase();
    return pgliteMcpTaskStorage({ query: (sql, params) => database.query(sql, params) });
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
    openTaskStorage: createDefaultTaskStorageOpener(),
  };
}

/**
 * Main's MCP stores for the Node host's runtime (BST-1930 c1 interim):
 * Electron's external opener. Bearer references and OAuth records live in the
 * profile store the host owns, Tasks in its StateStore.
 */
export function createDesktopMcpPlatformCapabilities(
  runtime: RemoteMcpRuntime
): DesktopMcpPlatformCapabilities {
  return {
    openExternal: openExternalWithElectron,
    runtime,
  };
}
