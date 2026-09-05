import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { EnvBootstrapReport } from '@brainstrike/assistant-contract/env-bootstrap-bridge';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  clearCachedAgentClient,
  getAgentProviderEnvKeys,
  listAgentProviders,
} from '../../agent-client-loader';
import type { DesktopEnvLoadFailure } from '../../desktop-env';
import { TAVILY_ENV_KEYS } from '../../tavily-env-keys';
import {
  createAllowlistedSenderFrame,
  reconfigureTestRendererTargetAfterModuleReset,
} from '../helpers/desktop-ipc-sender-frame-test-allowlist';

const { getWindowRoleByWebContentsIdMock } = vi.hoisted(() => ({
  getWindowRoleByWebContentsIdMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('../../window-role', () => ({
  getWindowRoleByWebContentsId: getWindowRoleByWebContentsIdMock,
}));

interface SecretsServiceMock {
  clearAll?: ReturnType<typeof vi.fn>;
  deleteKey: ReturnType<typeof vi.fn>;
  getCredential?: ReturnType<typeof vi.fn>;
  getKey: ReturnType<typeof vi.fn>;
  listProviders: ReturnType<typeof vi.fn>;
  saveKey: ReturnType<typeof vi.fn>;
  setCredential?: ReturnType<typeof vi.fn>;
}

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
const ORIGINAL_ELECTRON_E2E = process.env['ELECTRON_IS_E2E_TEST'];
const SECRETS_CLEAR_CONFIRMATION_TOKEN = 'CONFIRM_CLEAR_SECRETS';
const PROVIDER_ENV_KEYS = [
  ...new Set([
    ...listAgentProviders().flatMap((provider) => getAgentProviderEnvKeys(provider)),
    ...TAVILY_ENV_KEYS,
    // BST-1353: not provider CREDENTIAL names (so the registry does not
    // produce them), but they DO decide whether an aws row appears in this
    // listing — so the harness must isolate them like any other input. A
    // developer machine with AWS_PROFILE exported would otherwise fail
    // unrelated listing assertions.
    'AWS_PROFILE',
    'AWS_REGION',
    'AWS_ACCESS_KEY_ID',
  ]),
];
const ORIGINAL_PROVIDER_ENV = new Map(
  PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]] as const)
);

function restoreEnvVar(key: string, value: string | undefined): void {
  if (typeof value === 'string') {
    process.env[key] = value;
    return;
  }
  Reflect.deleteProperty(process.env, key);
}

function clearEnvVar(key: string): void {
  Reflect.deleteProperty(process.env, key);
}

function clearProviderEnv(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    clearEnvVar(key);
  }
}

function restoreProviderEnv(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    restoreEnvVar(key, ORIGINAL_PROVIDER_ENV.get(key));
  }
}

function createInvokeEvent(senderId = 7101): IpcMainInvokeEvent {
  return {
    sender: { id: senderId },
    senderFrame: createAllowlistedSenderFrame(),
  } as unknown as IpcMainInvokeEvent;
}

describe('registerSecretsIpcHandlers', () => {
  beforeEach(async () => {
    vi.resetModules();
    await reconfigureTestRendererTargetAfterModuleReset();
    vi.clearAllMocks();
    clearCachedAgentClient();
    getWindowRoleByWebContentsIdMock.mockReturnValue('visible-ui');

    restoreEnvVar('NODE_ENV', ORIGINAL_NODE_ENV);
    restoreEnvVar('ELECTRON_IS_E2E_TEST', ORIGINAL_ELECTRON_E2E);
    clearProviderEnv();
  });

  afterEach(async () => {
    restoreProviderEnv();
    clearCachedAgentClient();

    // Clear test mode secrets to prevent state leakage between tests
    const { clearTestModeSecrets } = await import('../../ipc-secrets');
    clearTestModeSecrets();
  });

  function skippedEnvBootstrapReport(): EnvBootstrapReport {
    return {
      appliedVariableCount: 0,
      credentialVariablesPresent: [],
      deprecatedVariablesInFiles: [],
      failures: [],
      loadedFiles: [],
      nonCredentialVariablesPresent: [],
      skipped: true,
    };
  }

  async function bootstrap(
    secretsService: SecretsServiceMock,
    envFileFailures: readonly DesktopEnvLoadFailure[] = [],
    readEnvBootstrapReport: () => EnvBootstrapReport = skippedEnvBootstrapReport
  ) {
    const { registerSecretsIpcHandlers } = await import('../../ipc-secrets');
    const { ipcMain } = await import('electron');

    registerSecretsIpcHandlers(
      secretsService as unknown as import('../../secrets').SecretsService,
      { envFileFailures, readEnvBootstrapReport }
    );

    const handleMock = ipcMain.handle as unknown as Mock<
      (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void
    >;
    const getHandler = (channel: string) => {
      const entry = handleMock.mock.calls.find(([name]) => name === channel);
      return entry?.[1] as ((event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) | undefined;
    };

    return { getHandler };
  }

  it('registers channels through the typed desktop IPC registry', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/ipc-secrets.ts'), 'utf8');

    expect(source).toContain('createDesktopIpcRegistry');
    expect(source).not.toMatch(/ipcMain\.(handle|on)\(/);
    expect(source).not.toMatch(/ipcMain\.remove(Handler|Listener)\(/);
  });

  it('merges env-configured providers with stored entries when listing', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['BRAINSTRIKE_OPENAI_API_KEY'] = 'sk-environment';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getCredential: vi.fn().mockResolvedValue({ key: 'sk-stored', type: 'api_key' }),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue(['anthropic', ' custom ']),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const listHandler = getHandler('secrets:list');
    expect(listHandler).toBeDefined();

    const result = await listHandler!(createInvokeEvent());

    // Env + stored providers should be merged (with whitespace trimmed)
    expect(result).toEqual([
      {
        envVar: 'BRAINSTRIKE_OPENAI_API_KEY',
        provider: 'openai',
        source: 'env',
      },
      { provider: 'anthropic', source: 'stored' },
    ]);
    expect(secretsService.listProviders).toHaveBeenCalledTimes(1);
  });

  it('projects the save-time fingerprint metadata onto stored list entries (BST-1362)', async () => {
    process.env['NODE_ENV'] = 'production';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getCredential: vi.fn().mockImplementation((provider: string) => {
        if (provider === 'anthropic') {
          return Promise.resolve({
            key: 'sk-ant-test-123',
            metadata: { last4: '-123', other: 'kept-private', savedAt: '2026-08-18T10:00:00.000Z' },
            type: 'api_key',
          });
        }
        return Promise.resolve({ key: 'sk-legacy', type: 'api_key' });
      }),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue(['anthropic', 'openai']),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const result = await getHandler('secrets:list')!(createInvokeEvent());

    // Only the fingerprint keys are projected; other metadata never crosses
    // the wire, and a credential without a fingerprint yields no metadata.
    expect(result).toEqual([
      {
        metadata: { last4: '-123', savedAt: '2026-08-18T10:00:00.000Z' },
        provider: 'anthropic',
        source: 'stored',
      },
      { provider: 'openai', source: 'stored' },
    ]);
  });

  it('projects the fingerprint from stored aws credentials too', async () => {
    process.env['NODE_ENV'] = 'production';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getCredential: vi.fn().mockResolvedValue({
        bearerKey: 'bedrock-bearer',
        metadata: { last4: 'arer', savedAt: '2026-08-18T10:00:00.000Z' },
        mode: 'bearer',
        region: 'us-east-1',
        type: 'aws',
      }),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue(['anthropic']),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const result = await getHandler('secrets:list')!(createInvokeEvent());

    expect(result).toEqual([
      {
        metadata: { last4: 'arer', savedAt: '2026-08-18T10:00:00.000Z' },
        provider: 'anthropic',
        source: 'stored',
      },
    ]);
  });

  // PR #2525 review, finding 4. `secrets:list` is the surface the Credential
  // Inventory actually renders from, and it has its OWN builders — separate
  // from inspectProviderKeys. Until these landed, a bedrock row configured
  // purely by AWS_REGION + AWS_PROFILE was ABSENT from this listing entirely:
  // the row rendered "Not set" with a Set button while the assistant reported
  // bedrock as configured and happily streamed.
  it('emits authMode on a stored aws credential (BST-1353)', async () => {
    process.env['NODE_ENV'] = 'production';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getCredential: vi.fn().mockResolvedValue({
        mode: 'profile_chain',
        profile: 'acme-dev',
        region: 'us-east-1',
        type: 'aws',
      }),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue(['bedrock']),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const result = await getHandler('secrets:list')!(createInvokeEvent());

    // No metadata: a profile chain holds no secret to fingerprint.
    expect(result).toEqual([{ authMode: 'profile_chain', provider: 'bedrock', source: 'stored' }]);
  });

  it('lists an ENV-CHAIN bedrock row that has no stored credential at all', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_PROFILE'] = 'acme-dev';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getCredential: vi.fn().mockResolvedValue(null),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue([]),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const result = (await getHandler('secrets:list')!(createInvokeEvent())) as unknown[];

    expect(result).toContainEqual({
      authMode: 'profile_chain',
      envVar: 'AWS_PROFILE',
      provider: 'bedrock',
      source: 'env',
    });
  });

  it('a stored BEARER outranks the env chain in the listing, matching the request path', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_PROFILE'] = 'acme-dev';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getCredential: vi.fn().mockResolvedValue({
        bearerKey: 'stored-bearer',
        mode: 'bearer',
        region: 'eu-west-1',
        type: 'aws',
      }),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue(['bedrock']),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const result = (await getHandler('secrets:list')!(createInvokeEvent())) as {
      authMode?: string;
      provider: string;
      source: string;
    }[];

    const bedrock = result.find((entry) => entry.provider === 'bedrock');
    expect(bedrock).toMatchObject({ authMode: 'bearer', source: 'stored' });
  });

  it('still lists a stored entry whose credential cannot be read, without metadata', async () => {
    process.env['NODE_ENV'] = 'production';

    const { SecretReadError } = await import('../../secrets');
    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getCredential: vi
        .fn()
        .mockRejectedValue(new SecretReadError('malformed_credential', 'anthropic')),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue(['anthropic']),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const result = await getHandler('secrets:list')!(createInvokeEvent());

    // The entry IS stored — that fact stands. The unreadable credential
    // surfaces through the status probe and every read path; the listing
    // only withholds the fingerprint it cannot know.
    expect(result).toEqual([{ provider: 'anthropic', source: 'stored' }]);
  });

  it('withholds a partial fingerprint instead of forwarding it (never guessed)', async () => {
    process.env['NODE_ENV'] = 'production';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getCredential: vi.fn().mockResolvedValue({
        key: 'sk-tampered',
        metadata: { last4: 'ered' },
        type: 'api_key',
      }),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue(['anthropic']),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const result = await getHandler('secrets:list')!(createInvokeEvent());

    expect(result).toEqual([{ provider: 'anthropic', source: 'stored' }]);
  });

  it('drops an out-of-shape fingerprint but keeps the entry listed (renderer-parser parity)', async () => {
    process.env['NODE_ENV'] = 'production';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getCredential: vi.fn().mockImplementation((provider: string) => {
        if (provider === 'anthropic') {
          // A five-character last4 would fail the renderer's shared parser
          // (and would leak key material) — main must not forward it.
          return Promise.resolve({
            key: 'sk-ant-tampered',
            metadata: { last4: 'pered', savedAt: '2026-08-18T10:00:00.000Z' },
            type: 'api_key',
          });
        }
        // An unparseable savedAt is equally out-of-shape.
        return Promise.resolve({
          key: 'sk-open-tampered',
          metadata: { last4: 'ered', savedAt: 'not-a-date' },
          type: 'api_key',
        });
      }),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue(['anthropic', 'openai']),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const result = await getHandler('secrets:list')!(createInvokeEvent());

    expect(result).toEqual([
      { provider: 'anthropic', source: 'stored' },
      { provider: 'openai', source: 'stored' },
    ]);
  });

  it('reports Tavily env credentials and keeps env authoritative over storage', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['BRAINSTRIKE_TAVILY_API_KEY'] = 'tvly-environment';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue(['tavily']),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const listHandler = getHandler('secrets:list');

    const result = (await listHandler!(createInvokeEvent())) as Array<{
      envVar?: string;
      provider: string;
      source: 'env' | 'stored';
    }>;

    expect(result).toEqual(
      expect.arrayContaining([
        {
          envVar: 'BRAINSTRIKE_TAVILY_API_KEY',
          provider: 'tavily',
          source: 'env',
        },
      ])
    );
    expect(result.filter(({ provider }) => provider === 'tavily')).toEqual([
      {
        envVar: 'BRAINSTRIKE_TAVILY_API_KEY',
        provider: 'tavily',
        source: 'env',
      },
    ]);
  });

  it('exposes stored providers-only list via secrets:listStored', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['BRAINSTRIKE_OPENAI_API_KEY'] = 'sk-environment';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue(['anthropic', ' custom ']),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const listHandler = getHandler('secrets:listStored');
    expect(listHandler).toBeDefined();

    const result = (await listHandler!(createInvokeEvent())) as string[];

    expect(result).toEqual(['anthropic', 'custom']);
    expect(result).not.toContain('openai');
    expect(secretsService.listProviders).toHaveBeenCalledTimes(1);
  });

  it('uses only in-memory secrets in test mode (ignores env vars)', async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['GOOGLE_GENERATIVE_AI_API_KEY'] = 'sk-google';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      listProviders: vi.fn(),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const saveHandler = getHandler('secrets:save');
    const listHandler = getHandler('secrets:list');
    const listStoredHandler = getHandler('secrets:listStored');

    expect(saveHandler).toBeDefined();
    expect(listHandler).toBeDefined();
    expect(listStoredHandler).toBeDefined();

    await saveHandler!(createInvokeEvent(), 'anthropic', 'sk-test-anthropic');
    const result = await listHandler!(createInvokeEvent());
    const storedResult = (await listStoredHandler!(createInvokeEvent())) as string[];

    // Test mode should only include in-memory secrets, NOT env vars
    expect(result).toEqual([{ provider: 'anthropic', source: 'stored' }]);
    expect(storedResult).toEqual(['anthropic']);
    expect(storedResult).not.toContain('google');
    expect(secretsService.listProviders).not.toHaveBeenCalled();
  });

  it('rejects credential inspection visibly when environment files failed to load', async () => {
    process.env['NODE_ENV'] = 'production';
    const failure: DesktopEnvLoadFailure = {
      code: 'env_file_invalid',
      file: 'dev-local',
      message: 'The development local environment file is malformed at line 3.',
    };
    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue([]),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService, [failure]);
    const listHandler = getHandler('secrets:list');

    await expect(listHandler!(createInvokeEvent())).rejects.toThrow(
      'The development local environment file is malformed at line 3.'
    );
    expect(secretsService.listProviders).not.toHaveBeenCalled();
  });

  it('requires confirmation token to clear secrets store', async () => {
    process.env['NODE_ENV'] = 'production';

    const secretsService: SecretsServiceMock = {
      clearAll: vi.fn().mockResolvedValue(true),
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue([]),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const clearHandler = getHandler('secrets:clearAll');
    expect(clearHandler).toBeDefined();

    const unauthorized = (await clearHandler!(createInvokeEvent())) as {
      success: false;
      message: string;
    };

    expect(unauthorized).toEqual({
      message: 'Unauthorized: Invalid confirmation token',
      success: false,
    });
    expect(secretsService.clearAll).toHaveBeenCalledTimes(0);

    const success = (await clearHandler!(
      createInvokeEvent(),
      SECRETS_CLEAR_CONFIRMATION_TOKEN
    )) as { success: true };

    expect(success).toEqual({ success: true });
    expect(secretsService.clearAll).toHaveBeenCalledTimes(1);
  });

  it.each(['chunking-host', 'embedding-host', 'llm-host', undefined])(
    'rejects every secret operation before dispatch for sender role %s',
    async (role) => {
      process.env['NODE_ENV'] = 'production';
      getWindowRoleByWebContentsIdMock.mockReturnValue(role);
      const secretsService: SecretsServiceMock = {
        clearAll: vi.fn().mockResolvedValue(true),
        deleteKey: vi.fn().mockResolvedValue(true),
        getCredential: vi.fn().mockResolvedValue({ key: 'secret', type: 'api_key' }),
        getKey: vi.fn().mockResolvedValue('secret'),
        listProviders: vi.fn().mockResolvedValue(['openai']),
        saveKey: vi.fn().mockResolvedValue(true),
        setCredential: vi.fn().mockResolvedValue(true),
      };
      const { getHandler } = await bootstrap(secretsService);
      const calls: ReadonlyArray<readonly [string, ...unknown[]]> = [
        ['secrets:save', 'openai', 'secret'],
        ['secrets:get', 'openai'],
        ['secrets:saveCredential', 'openai', { key: 'secret', type: 'api_key' }],
        ['secrets:getCredential', 'openai'],
        ['secrets:delete', 'openai'],
        ['secrets:list'],
        ['secrets:listStored'],
        ['secrets:clearAll', SECRETS_CLEAR_CONFIRMATION_TOKEN],
        ['secrets:envBootstrap'],
      ];

      for (const [channel, ...args] of calls) {
        await expect(getHandler(channel)?.(createInvokeEvent(), ...args)).rejects.toThrow(
          `Desktop IPC ${channel} requires sender role visible-ui.`
        );
      }

      expect(secretsService.saveKey).not.toHaveBeenCalled();
      expect(secretsService.getKey).not.toHaveBeenCalled();
      expect(secretsService.setCredential).not.toHaveBeenCalled();
      expect(secretsService.getCredential).not.toHaveBeenCalled();
      expect(secretsService.deleteKey).not.toHaveBeenCalled();
      expect(secretsService.listProviders).not.toHaveBeenCalled();
      expect(secretsService.clearAll).not.toHaveBeenCalled();
    }
  );

  describe('env bootstrap projection channel (BST-1363)', () => {
    const devReport: EnvBootstrapReport = {
      appliedVariableCount: 2,
      credentialVariablesPresent: ['BRAINSTRIKE_OPENAI_API_KEY'],
      deprecatedVariablesInFiles: ['OPENAI_API_KEY'],
      failures: [],
      loadedFiles: [{ file: 'dev', path: '/app/root/.env' }],
      nonCredentialVariablesPresent: ['AWS_REGION'],
      skipped: false,
    };

    function secretsServiceStub(): SecretsServiceMock {
      return {
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        listProviders: vi.fn().mockResolvedValue([]),
        saveKey: vi.fn(),
      };
    }

    it('returns the recorded bootstrap projection without re-running env loading', async () => {
      process.env['NODE_ENV'] = 'production';
      const readEnvBootstrapReport = vi.fn(() => devReport);
      const { getHandler } = await bootstrap(secretsServiceStub(), [], readEnvBootstrapReport);

      const result = await getHandler('secrets:envBootstrap')?.(createInvokeEvent());

      expect(result).toEqual(devReport);
      expect(readEnvBootstrapReport).toHaveBeenCalledTimes(1);
    });

    it('re-reads the projection on every invoke so a restart-fresh value is never cached', async () => {
      process.env['NODE_ENV'] = 'production';
      const readEnvBootstrapReport = vi.fn(() => devReport);
      const { getHandler } = await bootstrap(secretsServiceStub(), [], readEnvBootstrapReport);

      await getHandler('secrets:envBootstrap')?.(createInvokeEvent());
      await getHandler('secrets:envBootstrap')?.(createInvokeEvent());

      expect(readEnvBootstrapReport).toHaveBeenCalledTimes(2);
    });

    it('surfaces the projection even when env files failed to parse', async () => {
      process.env['NODE_ENV'] = 'production';
      const failureReport: EnvBootstrapReport = {
        ...devReport,
        appliedVariableCount: 0,
        failures: [
          {
            code: 'env_file_invalid',
            file: 'dev-local',
            message:
              'Desktop environment file "dev-local" is invalid at line 4: unsupported variable name.',
            path: '/app/root/.env.local',
          },
        ],
        loadedFiles: [],
      };
      const { getHandler } = await bootstrap(secretsServiceStub(), [], () => failureReport);

      // `secrets:list` THROWS on env-file failures by design; this channel is
      // the one that must still answer — it exists to explain the failure.
      await expect(getHandler('secrets:envBootstrap')?.(createInvokeEvent())).resolves.toEqual(
        failureReport
      );
    });
  });

  describe('typed credential channels (BST-1348)', () => {
    const oauthCredential = {
      access: 'at-1',
      accountId: 'acct-9',
      expires: 1_755_500_000_000,
      refresh: 'rt-1',
      type: 'oauth',
    } as const;
    const typedCredentials = [
      ['api_key', { key: 'sk-typed', metadata: { org: 'org-1' }, type: 'api_key' }],
      ['oauth', oauthCredential],
      ['aws', { bearerKey: 'bedrock-bearer', mode: 'bearer', region: 'us-east-1', type: 'aws' }],
    ] as const;

    it.each(typedCredentials)(
      'round-trips a %s credential through saveCredential → getCredential in test mode',
      async (_type, credential) => {
        process.env['NODE_ENV'] = 'test';
        const secretsService: SecretsServiceMock = {
          deleteKey: vi.fn(),
          getKey: vi.fn(),
          listProviders: vi.fn(),
          saveKey: vi.fn(),
        };

        const { getHandler } = await bootstrap(secretsService);
        const saveCredentialHandler = getHandler('secrets:saveCredential');
        const getCredentialHandler = getHandler('secrets:getCredential');
        expect(saveCredentialHandler).toBeDefined();
        expect(getCredentialHandler).toBeDefined();

        await expect(
          saveCredentialHandler!(createInvokeEvent(), 'anthropic', credential)
        ).resolves.toBe(true);
        await expect(getCredentialHandler!(createInvokeEvent(), 'anthropic')).resolves.toEqual({
          credential,
          ok: true,
        });
      }
    );

    it('maps a legacy string saved via secrets:save to an api_key credential in test mode', async () => {
      process.env['NODE_ENV'] = 'test';
      const secretsService: SecretsServiceMock = {
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        listProviders: vi.fn(),
        saveKey: vi.fn(),
      };

      const { getHandler } = await bootstrap(secretsService);
      await getHandler('secrets:save')!(createInvokeEvent(), 'openai', 'sk-raw');

      await expect(
        getHandler('secrets:getCredential')!(createInvokeEvent(), 'openai')
      ).resolves.toEqual({ credential: { key: 'sk-raw', type: 'api_key' }, ok: true });
      await expect(getHandler('secrets:get')!(createInvokeEvent(), 'openai')).resolves.toBe(
        'sk-raw'
      );
    });

    it('round-trips a GCP service-account JSON saved via secrets:save in test mode (envelope parity)', async () => {
      process.env['NODE_ENV'] = 'test';
      const gcpServiceAccountJson = '{"type":"service_account","project_id":"p"}';
      const secretsService: SecretsServiceMock = {
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        listProviders: vi.fn(),
        saveKey: vi.fn(),
      };

      const { getHandler } = await bootstrap(secretsService);
      await getHandler('secrets:save')!(createInvokeEvent(), 'vertex', gcpServiceAccountJson);

      await expect(getHandler('secrets:get')!(createInvokeEvent(), 'vertex')).resolves.toBe(
        gcpServiceAccountJson
      );
      await expect(
        getHandler('secrets:getCredential')!(createInvokeEvent(), 'vertex')
      ).resolves.toEqual({
        credential: { key: gcpServiceAccountJson, type: 'api_key' },
        ok: true,
      });
    });

    it('secrets:get on a stored oauth credential throws in test mode (never a stringified credential)', async () => {
      process.env['NODE_ENV'] = 'test';
      const secretsService: SecretsServiceMock = {
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        listProviders: vi.fn(),
        saveKey: vi.fn(),
      };

      const { getHandler } = await bootstrap(secretsService);
      await getHandler('secrets:saveCredential')!(
        createInvokeEvent(),
        'anthropic',
        oauthCredential
      );

      await expect(
        getHandler('secrets:get')!(createInvokeEvent(), 'anthropic')
      ).rejects.toMatchObject({
        code: 'credential_type_unsupported',
        name: 'SecretReadError',
        provider: 'anthropic',
      });
    });

    it('lists the fingerprint metadata for test-mode typed saves and omits it for legacy saves', async () => {
      process.env['NODE_ENV'] = 'test';
      const secretsService: SecretsServiceMock = {
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        listProviders: vi.fn(),
        saveKey: vi.fn(),
      };

      const { getHandler } = await bootstrap(secretsService);
      await getHandler('secrets:saveCredential')!(createInvokeEvent(), 'anthropic', {
        key: 'sk-ant-test-123',
        metadata: { last4: '-123', savedAt: '2026-08-18T10:00:00.000Z' },
        type: 'api_key',
      });
      await getHandler('secrets:save')!(createInvokeEvent(), 'openai', 'sk-legacy');

      await expect(getHandler('secrets:list')!(createInvokeEvent())).resolves.toEqual([
        {
          metadata: { last4: '-123', savedAt: '2026-08-18T10:00:00.000Z' },
          provider: 'anthropic',
          source: 'stored',
        },
        { provider: 'openai', source: 'stored' },
      ]);
    });

    it('saveCredential returns a malformed_credential result for an unrecognized type in test mode, storing nothing', async () => {
      process.env['NODE_ENV'] = 'test';
      const secretsService: SecretsServiceMock = {
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        listProviders: vi.fn(),
        saveKey: vi.fn(),
      };

      const { getHandler } = await bootstrap(secretsService);
      await expect(
        getHandler('secrets:saveCredential')!(createInvokeEvent(), 'openai', {
          key: 'x',
          type: 'gcp',
        })
      ).resolves.toEqual({ error: 'malformed_credential', ok: false });

      await expect(
        getHandler('secrets:getCredential')!(createInvokeEvent(), 'openai')
      ).resolves.toEqual({ credential: null, ok: true });
    });

    it('delegates saveCredential and getCredential to the secrets service in production', async () => {
      process.env['NODE_ENV'] = 'production';
      const secretsService: SecretsServiceMock = {
        deleteKey: vi.fn(),
        getCredential: vi.fn().mockResolvedValue(oauthCredential),
        getKey: vi.fn(),
        listProviders: vi.fn(),
        saveKey: vi.fn(),
        setCredential: vi.fn().mockResolvedValue(true),
      };

      const { getHandler } = await bootstrap(secretsService);

      await expect(
        getHandler('secrets:saveCredential')!(createInvokeEvent(), 'anthropic', oauthCredential)
      ).resolves.toBe(true);
      expect(secretsService.setCredential).toHaveBeenCalledWith('anthropic', oauthCredential);

      await expect(
        getHandler('secrets:getCredential')!(createInvokeEvent(), 'anthropic')
      ).resolves.toEqual({ credential: oauthCredential, ok: true });
      expect(secretsService.getCredential).toHaveBeenCalledWith('anthropic');
    });

    it('maps a malformed saveCredential payload to a structured result via the SINGLE validator (setCredential)', async () => {
      process.env['NODE_ENV'] = 'production';
      // Dynamic import: vi.resetModules() runs per test, so the class must
      // share module identity with the handler's own import for instanceof.
      const { MalformedCredentialError } = await import('@brainstrike/assistant-contract');
      const secretsService: SecretsServiceMock = {
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        listProviders: vi.fn(),
        saveKey: vi.fn(),
        setCredential: vi
          .fn()
          .mockRejectedValue(new MalformedCredentialError('credential has missing fields')),
      };

      const { getHandler } = await bootstrap(secretsService);

      await expect(
        getHandler('secrets:saveCredential')!(createInvokeEvent(), 'openai', { type: 'oauth' })
      ).resolves.toEqual({ error: 'malformed_credential', ok: false });
      expect(secretsService.setCredential).toHaveBeenCalledWith('openai', { type: 'oauth' });
    });

    it('serializes a SecretReadError from getCredential as data (invoke drops custom props)', async () => {
      process.env['NODE_ENV'] = 'production';
      // Dynamic import: shares module identity with the handler's own import.
      const { SecretReadError } = await import('../../secrets');
      const secretsService: SecretsServiceMock = {
        deleteKey: vi.fn(),
        getCredential: vi
          .fn()
          .mockRejectedValue(new SecretReadError('malformed_credential', 'openai')),
        getKey: vi.fn(),
        listProviders: vi.fn(),
        saveKey: vi.fn(),
        setCredential: vi.fn(),
      };

      const { getHandler } = await bootstrap(secretsService);

      await expect(
        getHandler('secrets:getCredential')!(createInvokeEvent(), 'openai')
      ).resolves.toEqual({ error: 'malformed_credential', ok: false, provider: 'openai' });
    });

    it('secrets:save maps a MalformedCredentialError (e.g. empty key) to a structured result', async () => {
      process.env['NODE_ENV'] = 'production';
      // Dynamic import: shares module identity with the handler's own import.
      const { MalformedCredentialError } = await import('@brainstrike/assistant-contract');
      const secretsService: SecretsServiceMock = {
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        listProviders: vi.fn(),
        saveKey: vi
          .fn()
          .mockRejectedValue(new MalformedCredentialError('credential has missing fields')),
      };

      const { getHandler } = await bootstrap(secretsService);

      await expect(getHandler('secrets:save')!(createInvokeEvent(), 'openai', '')).resolves.toEqual(
        { error: 'malformed_credential', ok: false }
      );
    });

    it('maps encryption_unavailable from setCredential to the structured save error result', async () => {
      process.env['NODE_ENV'] = 'production';
      const secretsService: SecretsServiceMock = {
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        listProviders: vi.fn(),
        saveKey: vi.fn(),
        setCredential: vi.fn().mockRejectedValue(new Error('encryption_unavailable')),
      };

      const { getHandler } = await bootstrap(secretsService);

      await expect(
        getHandler('secrets:saveCredential')!(createInvokeEvent(), 'openai', {
          key: 'sk',
          type: 'api_key',
        })
      ).resolves.toEqual({ error: 'encryption_unavailable', ok: false });
    });
  });
});
