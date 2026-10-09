import { readFile } from 'node:fs/promises';
import { collectCombinedTools } from '@brainstrike/agent/mcp-client';
import type { HostStartupContext } from '@brainstrike/agent-host';
import { isMcpOAuthCredentialAccount } from '@brainstrike/agent-host/file-credentials';
import {
  parseMcpConfigValue,
  type ResolvedMcpConfig,
} from '@brainstrike/assistant-contract/mcp-config';
import type { HostCredentials } from '../credentials.js';
import { createSecretsMcpBearerCredentialAuthority } from './bearer-credential.js';
import { createCredentialMcpOAuthStore } from './credential-oauth-store.js';
import { createMcpHostServices, type McpHostServices } from './mcp-host-services.js';
import {
  createLazySafeStorageMcpOAuthStore,
  identityKey,
  parseRecords,
} from './oauth-client-provider.js';
import { stateStoreMcpTaskStorage } from './state-store-task-storage.js';

export class CliMcpCapabilityUnavailableError extends Error {
  readonly code = 'mcp-cli-capability-unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'CliMcpCapabilityUnavailableError';
  }
}

/**
 * The desktop loader decrypts header/env keys ending in `Encrypted` with
 * Electron safeStorage (`mcp-loader.ts`); a standalone host has none, so such a
 * key is refused rather than sent as a literal ciphertext value.
 */
function refuseEncryptedValues(config: ResolvedMcpConfig): void {
  for (const server of config.servers) {
    const values = server.transport === 'stdio' ? server.env : server.headers;
    const encrypted = Object.keys(values ?? {}).find((key) => key.endsWith('Encrypted'));
    if (encrypted) {
      throw new CliMcpCapabilityUnavailableError(
        `MCP server ${server.name} value ${encrypted} needs Electron safeStorage, which a standalone host cannot read`
      );
    }
  }
}

/**
 * The standalone host's MCP runtime, from the desktop's config JSON. Text Apps
 * only; MCP Tasks live in this host's StateStore and their input is answered
 * with `mcp input settle`; browser OAuth has no opener. Each refusal names
 * itself instead of failing silently.
 */
export async function createCliMcpHost(options: {
  readonly configPath: string;
  readonly credentials: HostCredentials;
  readonly startup: Pick<HostStartupContext, 'signal' | 'store'>;
}): Promise<McpHostServices> {
  const { config } = parseMcpConfigValue(JSON.parse(await readFile(options.configPath, 'utf8')));
  refuseEncryptedValues(config);
  return await createMcpHostServices({
    appUi: 'text',
    // Host-owned input goes to Core; the CLI answers it with `mcp input settle`.
    attachElicitationPresenter: () => () => undefined,
    bearerCredentialAuthority: createSecretsMcpBearerCredentialAuthority({
      getKey: (key) => options.credentials.secrets().getKey(key),
      listProviders: () => options.credentials.secrets().listProviders(),
    }),
    collectCombinedTools,
    extensionPreferences: { apps: false, tasks: true },
    mcpConfiguration: config,
    // The shared credential store holds OAuth records under their own accounts.
    oauthStore: createLazySafeStorageMcpOAuthStore(() =>
      createCredentialMcpOAuthStore({
        accountForIdentity: identityKey,
        credentials: options.credentials.store(),
        ownsAccount: isMcpOAuthCredentialAccount,
        parseRecords,
      })
    ),
    openExternal: async () => {
      throw new CliMcpCapabilityUnavailableError(
        'Browser authorization is unavailable on a standalone host'
      );
    },
    openTaskStorage: async () => stateStoreMcpTaskStorage(options.startup.store),
    startup: options.startup,
  });
}
