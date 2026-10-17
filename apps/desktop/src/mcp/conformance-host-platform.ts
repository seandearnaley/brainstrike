import type { McpTaskStorage } from '@brainstrike/assistant-contract/mcp-task-store';
import {
  createSecretsMcpBearerCredentialAuthority,
  type McpBearerCredentialAuthority,
} from '@brainstrike/host-capabilities/mcp/bearer-credential';
import type { McpHostRuntimePlatform } from '@brainstrike/host-capabilities/mcp/node-host-runtime';
import {
  createLazySafeStorageMcpOAuthStore,
  type McpOAuthStore,
} from '@brainstrike/host-capabilities/mcp/oauth-client-provider';
import { openExternalWithElectron } from './open-external';

export interface DesktopMcpHostPlatformDependencies {
  readonly bearerCredentialAuthority?: McpBearerCredentialAuthority;
  readonly oauthStore?: McpOAuthStore;
  readonly openExternal?: (url: string) => Promise<void>;
  /** The MCP Tasks store this runtime writes; the agent host composes its own StateStore's. */
  readonly openTaskStorage?: () => Promise<McpTaskStorage>;
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

/** A runtime composed without a Tasks store refuses MCP Tasks instead of inventing one. */
async function refuseTaskStorage(): Promise<McpTaskStorage> {
  throw new Error(
    'This desktop MCP runtime was composed without an MCP Tasks store; pass openTaskStorage.'
  );
}

/** Only desktop composition may select Electron-backed stores, opener and Tasks store. */
export function createDesktopMcpHostPlatform(
  dependencies: DesktopMcpHostPlatformDependencies = {}
): McpHostRuntimePlatform {
  return {
    appUi: 'rich',
    bearerCredentialAuthority:
      dependencies.bearerCredentialAuthority ?? createDefaultBearerCredentialAuthority(),
    oauthStore: dependencies.oauthStore ?? createDefaultOAuthStore(),
    openExternal: dependencies.openExternal ?? openExternalWithElectron,
    openTaskStorage: dependencies.openTaskStorage ?? refuseTaskStorage,
  };
}
