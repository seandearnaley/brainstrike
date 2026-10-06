import type { McpTaskDatabase } from '@brainstrike/db';
import {
  createSecretsMcpBearerCredentialAuthority,
  type McpBearerCredentialAuthority,
} from './bearer-credential';
import type { McpHostRuntimePlatform } from './node-host-runtime';
import { createLazySafeStorageMcpOAuthStore, type McpOAuthStore } from './oauth-client-provider';
import { openExternalWithElectron } from './open-external';

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
