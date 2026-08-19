import { matchSecretReadError } from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const mockGetAgentProviderEnvKeys = vi.hoisted(() => vi.fn());
const mockListAgentProviders = vi.hoisted(() => vi.fn());
const mockGetSecretsService = vi.hoisted(() => vi.fn());
const mockIsSupportedProvider = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/logging', () => ({
  createLogger: () => logger,
}));

vi.mock('@brainstrike/agent', () => ({
  isSupportedProvider: (value: string) => mockIsSupportedProvider(value),
}));

vi.mock('../../agent-client-loader', () => ({
  getAgentProviderEnvKeys: (provider: string) => mockGetAgentProviderEnvKeys(provider),
  listAgentProviders: () => mockListAgentProviders(),
}));

vi.mock('../../secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../secrets')>();
  return {
    ...actual,
    getSecretsService: () => mockGetSecretsService(),
  };
});

import {
  inspectProviderKeys,
  listConfiguredProviders,
  readProviderApiKey,
  readProviderCredential,
  readProviderSecretKey,
  resolveProviderEnvCredential,
  resolveProviderEnvKey,
} from '../../provider-api-key';

describe('provider-api-key', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves provider env keys in order', () => {
    mockGetAgentProviderEnvKeys.mockReturnValue(['KEY_ONE', 'KEY_TWO']);
    process.env['KEY_TWO'] = '  token  ';

    expect(resolveProviderEnvKey('openai')).toBe('token');
    expect(resolveProviderEnvCredential('openai')).toEqual({
      envVar: 'KEY_TWO',
      value: 'token',
    });
  });

  it('reads provider secret key and preserves read failures', async () => {
    const secrets = {
      getKey: vi.fn().mockResolvedValue('  secret  '),
    };
    mockGetSecretsService.mockReturnValue(secrets);

    await expect(readProviderSecretKey('openai')).resolves.toBe('secret');

    const readError = new Error('boom');
    secrets.getKey.mockRejectedValueOnce(readError);
    await expect(readProviderSecretKey('openai')).rejects.toBe(readError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('prefers env key over secrets', async () => {
    mockGetAgentProviderEnvKeys.mockReturnValue(['OPENAI_KEY']);
    process.env['OPENAI_KEY'] = 'env-key';

    const secrets = {
      getKey: vi.fn().mockResolvedValue('secret-key'),
    };
    mockGetSecretsService.mockReturnValue(secrets);

    await expect(readProviderApiKey('openai')).resolves.toBe('env-key');
    expect(secrets.getKey).not.toHaveBeenCalled();
  });

  it('lists configured providers from env and secrets', async () => {
    mockListAgentProviders.mockReturnValue(['openai', 'anthropic']);
    mockGetAgentProviderEnvKeys.mockImplementation((provider: string) =>
      provider === 'openai' ? ['OPENAI_KEY'] : ['ANTHROPIC_KEY']
    );
    process.env['OPENAI_KEY'] = 'env-openai';

    const secrets = {
      getCredential: vi.fn().mockResolvedValue({ key: ' secret ', type: 'api_key' }),
      listProviders: vi.fn().mockResolvedValue(['anthropic', 'unknown']),
    };
    mockGetSecretsService.mockReturnValue(secrets);

    mockIsSupportedProvider.mockImplementation((value: string) => value === 'anthropic');

    await expect(inspectProviderKeys()).resolves.toEqual({
      configuredProviders: [
        { envVar: 'OPENAI_KEY', provider: 'openai', source: 'env' },
        { provider: 'anthropic', source: 'stored' },
      ],
      readFailures: [],
    });

    const providers = await listConfiguredProviders();
    expect(providers).toEqual(expect.arrayContaining(['openai', 'anthropic']));
  });

  it('marks bedrock configured from AWS_BEARER_TOKEN_BEDROCK (BST-1350 env path)', async () => {
    // The env-name table is registry-derived in production
    // (agent-client-loader ⇒ provider-registry envKeys, pinned by
    // agent-client-loader.test.ts); this pins the availability mechanics on
    // the real bedrock names. AWS_REGION deliberately plays no role in
    // AVAILABILITY — it pairs with the key at auth-projection time.
    mockListAgentProviders.mockReturnValue(['bedrock']);
    mockGetAgentProviderEnvKeys.mockReturnValue([
      'BRAINSTRIKE_BEDROCK_API_KEY',
      'AWS_BEARER_TOKEN_BEDROCK',
    ]);
    process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'env-bedrock-bearer';
    mockGetSecretsService.mockReturnValue({
      getCredential: vi.fn(),
      listProviders: vi.fn().mockResolvedValue([]),
    });

    await expect(inspectProviderKeys()).resolves.toEqual({
      configuredProviders: [
        {
          // BST-1353: every registry env key is a bearer token, so an env hit
          // on an aws provider reports bearer mode — the badge names the
          // winner of the precedence table.
          authMode: 'bearer',
          envVar: 'AWS_BEARER_TOKEN_BEDROCK',
          provider: 'bedrock',
          source: 'env',
        },
      ],
      readFailures: [],
    });
  });

  it('does not inspect a stale stored key when an env key is authoritative', async () => {
    mockListAgentProviders.mockReturnValue(['openai']);
    mockGetAgentProviderEnvKeys.mockReturnValue(['OPENAI_KEY']);
    process.env['OPENAI_KEY'] = 'env-openai';

    const secrets = {
      getCredential: vi.fn().mockRejectedValue(new Error('stale stored key')),
      listProviders: vi.fn().mockResolvedValue(['openai']),
    };
    mockGetSecretsService.mockReturnValue(secrets);
    mockIsSupportedProvider.mockReturnValue(true);

    await expect(inspectProviderKeys()).resolves.toEqual({
      configuredProviders: [{ envVar: 'OPENAI_KEY', provider: 'openai', source: 'env' }],
      readFailures: [],
    });
    expect(secrets.getCredential).not.toHaveBeenCalled();
  });

  it('counts a stored typed (non-api_key) credential as CONFIGURED (BST-1352 review)', async () => {
    // The status verdict and the wave-3 typed-consumer verdict are unified:
    // a VALID stored credential of ANY type marks the provider configured
    // (source 'stored'); only malformed/unreadable entries stay readFailures.
    mockListAgentProviders.mockReturnValue(['anthropic', 'openai']);
    mockGetAgentProviderEnvKeys.mockReturnValue([]);
    mockIsSupportedProvider.mockReturnValue(true);

    const secrets = {
      getCredential: vi.fn((provider: string) =>
        provider === 'anthropic'
          ? Promise.resolve({ access: 'a', expires: 1, refresh: 'r', type: 'oauth' })
          : Promise.resolve({ key: 'sk-openai', type: 'api_key' })
      ),
      listProviders: vi.fn().mockResolvedValue(['anthropic', 'openai']),
    };
    mockGetSecretsService.mockReturnValue(secrets);

    await expect(inspectProviderKeys()).resolves.toEqual({
      configuredProviders: [
        { provider: 'anthropic', source: 'stored' },
        { provider: 'openai', source: 'stored' },
      ],
      readFailures: [],
    });
  });

  it('keeps a MALFORMED stored credential as a per-provider read failure', async () => {
    mockListAgentProviders.mockReturnValue(['anthropic', 'openai']);
    mockGetAgentProviderEnvKeys.mockReturnValue([]);
    mockIsSupportedProvider.mockReturnValue(true);

    const { SecretReadError } = await import('../../secrets');
    const secrets = {
      getCredential: vi.fn((provider: string) =>
        provider === 'anthropic'
          ? Promise.reject(new SecretReadError('malformed_credential', 'anthropic'))
          : Promise.resolve({ key: 'sk-openai', type: 'api_key' })
      ),
      listProviders: vi.fn().mockResolvedValue(['anthropic', 'openai']),
    };
    mockGetSecretsService.mockReturnValue(secrets);

    await expect(inspectProviderKeys()).resolves.toMatchObject({
      configuredProviders: [{ provider: 'openai', source: 'stored' }],
      readFailures: [{ code: 'malformed_credential', provider: 'anthropic' }],
    });
  });

  describe('readProviderCredential (BST-1352 typed reader)', () => {
    it('tags an env hit as an api_key credential with source env and never reads the store', async () => {
      mockGetAgentProviderEnvKeys.mockReturnValue(['OPENAI_KEY']);
      process.env['OPENAI_KEY'] = '  env-key  ';
      const secrets = { getCredential: vi.fn() };
      mockGetSecretsService.mockReturnValue(secrets);

      await expect(readProviderCredential('openai')).resolves.toEqual({
        key: 'env-key',
        source: 'env',
        type: 'api_key',
      });
      expect(secrets.getCredential).not.toHaveBeenCalled();
    });

    it('tags a stored typed credential with source stored', async () => {
      mockGetAgentProviderEnvKeys.mockReturnValue(['ANTHROPIC_KEY']);
      const oauth = { access: 'a', expires: 1, refresh: 'r', type: 'oauth' as const };
      const secrets = { getCredential: vi.fn().mockResolvedValue(oauth) };
      mockGetSecretsService.mockReturnValue(secrets);

      await expect(readProviderCredential('anthropic')).resolves.toEqual({
        ...oauth,
        source: 'stored',
      });
    });

    it('normalizes a stored api_key credential like the legacy string read (trim; blank = unset)', async () => {
      mockGetAgentProviderEnvKeys.mockReturnValue([]);
      const secrets = {
        getCredential: vi.fn().mockResolvedValue({ key: '  padded  ', type: 'api_key' }),
      };
      mockGetSecretsService.mockReturnValue(secrets);
      await expect(readProviderCredential('openai')).resolves.toEqual({
        key: 'padded',
        source: 'stored',
        type: 'api_key',
      });

      secrets.getCredential.mockResolvedValueOnce({ key: '   ', type: 'api_key' });
      await expect(readProviderCredential('openai')).resolves.toBeUndefined();
    });

    it('returns undefined when nothing is configured', async () => {
      mockGetAgentProviderEnvKeys.mockReturnValue([]);
      const secrets = { getCredential: vi.fn().mockResolvedValue(null) };
      mockGetSecretsService.mockReturnValue(secrets);
      await expect(readProviderCredential('openai')).resolves.toBeUndefined();
    });

    it('rethrows a credential-store read failure (logged, never swallowed)', async () => {
      mockGetAgentProviderEnvKeys.mockReturnValue([]);
      const readError = new Error('decrypt boom');
      const secrets = { getCredential: vi.fn().mockRejectedValue(readError) };
      mockGetSecretsService.mockReturnValue(secrets);
      await expect(readProviderCredential('openai')).rejects.toBe(readError);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  it('reports one unreadable-key failure for duplicate stored provider ids', async () => {
    mockListAgentProviders.mockReturnValue(['openrouter']);
    mockGetAgentProviderEnvKeys.mockReturnValue(['OPENROUTER_API_KEY']);
    mockIsSupportedProvider.mockReturnValue(true);

    const { SecretReadError } = await import('../../secrets');
    const secrets = {
      getCredential: vi.fn().mockRejectedValue(new SecretReadError('decrypt_failed', 'openrouter')),
      listProviders: vi.fn().mockResolvedValue(['openrouter', 'openrouter']),
    };
    mockGetSecretsService.mockReturnValue(secrets);

    await expect(inspectProviderKeys()).resolves.toMatchObject({
      configuredProviders: [],
      readFailures: [{ code: 'decrypt_failed', provider: 'openrouter' }],
    });
    expect(secrets.getCredential).toHaveBeenCalledTimes(1);
  });

  it('resolves an env credential even when the secrets service cannot be constructed (lazy store, BST-1352 review)', async () => {
    // The store must be acquired only INSIDE the stored-read callback: an env
    // hit never touches (or constructs) the keychain-backed service.
    mockGetAgentProviderEnvKeys.mockReturnValue(['OPENAI_KEY']);
    process.env['OPENAI_KEY'] = 'env-key';
    mockGetSecretsService.mockImplementation(() => {
      throw new Error('secrets service must not be constructed for an env hit');
    });

    await expect(readProviderCredential('openai')).resolves.toEqual({
      key: 'env-key',
      source: 'env',
      type: 'api_key',
    });
    expect(mockGetSecretsService).not.toHaveBeenCalled();
  });
});

/**
 * BST-1353 — the AWS auth PRECEDENCE TABLE, which is the whole point of this
 * block. Two orthogonal axes, bearer-vs-chain first:
 *
 *   1. env bearer   2. stored bearer   3. env chain   4. stored chain
 *
 * Rung 2 outranking rung 3 is deliberate and easy to "fix" wrongly: a bearer
 * key is an EXPLICIT Bedrock credential the user typed into Settings, while an
 * AWS environment is ambient and frequently set for unrelated tooling.
 */
describe('provider-api-key AWS auth precedence (BST-1353)', () => {
  const originalEnv = { ...process.env };
  const BEDROCK_ENV_KEYS = ['BRAINSTRIKE_BEDROCK_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK'];

  function useStoredCredential(credential: unknown): void {
    mockGetSecretsService.mockReturnValue({
      getCredential: vi.fn().mockResolvedValue(credential),
      listProviders: vi.fn().mockResolvedValue(credential === null ? [] : ['bedrock']),
    });
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('AWS_')) {
        delete process.env[name];
      }
    }
    vi.clearAllMocks();
    mockIsSupportedProvider.mockReturnValue(true);
    mockListAgentProviders.mockReturnValue(['bedrock']);
    mockGetAgentProviderEnvKeys.mockReturnValue(BEDROCK_ENV_KEYS);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rung 1 beats rung 2: an env bearer wins over a stored bearer', async () => {
    process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'env-bearer';
    useStoredCredential({
      bearerKey: 'stored-bearer',
      mode: 'bearer',
      region: 'us-east-1',
      type: 'aws',
    });

    await expect(readProviderCredential('bedrock')).resolves.toMatchObject({
      key: 'env-bearer',
      source: 'env',
      type: 'api_key',
    });
  });

  it('rung 2 beats rung 3: a STORED BEARER wins over an activated env chain', async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_PROFILE'] = 'acme-dev';
    useStoredCredential({
      bearerKey: 'stored-bearer',
      mode: 'bearer',
      region: 'eu-west-1',
      type: 'aws',
    });

    await expect(readProviderCredential('bedrock')).resolves.toMatchObject({
      bearerKey: 'stored-bearer',
      mode: 'bearer',
      source: 'stored',
    });
  });

  it('rung 3 beats rung 4: an env chain wins over a stored chain (env > stored within a mode)', async () => {
    process.env['AWS_REGION'] = 'us-west-2';
    process.env['AWS_PROFILE'] = 'env-profile';
    useStoredCredential({
      mode: 'profile_chain',
      profile: 'stored-profile',
      region: 'eu-west-1',
      type: 'aws',
    });

    await expect(readProviderCredential('bedrock')).resolves.toMatchObject({
      mode: 'profile_chain',
      profile: 'env-profile',
      region: 'us-west-2',
      source: 'env',
    });
  });

  it('rung 4: a stored chain resolves when no env AWS configuration exists', async () => {
    useStoredCredential({
      mode: 'profile_chain',
      profile: 'stored-profile',
      region: 'eu-west-1',
      type: 'aws',
    });

    await expect(readProviderCredential('bedrock')).resolves.toMatchObject({
      mode: 'profile_chain',
      profile: 'stored-profile',
      source: 'stored',
    });
  });

  it('ACTIVATION: AWS_REGION alone does NOT activate the chain', async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    useStoredCredential(null);

    await expect(readProviderCredential('bedrock')).resolves.toBeUndefined();
  });

  it('ACTIVATION: AWS_PROFILE without AWS_REGION does NOT activate the chain', async () => {
    process.env['AWS_PROFILE'] = 'acme-dev';
    useStoredCredential(null);

    await expect(readProviderCredential('bedrock')).resolves.toBeUndefined();
  });

  it('ACTIVATION: AWS_ACCESS_KEY_ID also activates it, with no profile', async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAEXAMPLE';
    useStoredCredential(null);

    const credential = await readProviderCredential('bedrock');
    expect(credential).toMatchObject({ mode: 'profile_chain', region: 'us-east-1', source: 'env' });
    // No AWS_PROFILE ⇒ no profile field at all (the chain's own default).
    expect((credential as { profile?: string } | undefined)?.profile).toBeUndefined();
  });

  it('ACTIVATION: an env bearer suppresses the chain entirely', async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_PROFILE'] = 'acme-dev';
    process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'env-bearer';
    useStoredCredential(null);

    await expect(readProviderCredential('bedrock')).resolves.toMatchObject({
      key: 'env-bearer',
      type: 'api_key',
    });
  });

  it('does NOT activate the chain for a non-aws provider', async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_PROFILE'] = 'acme-dev';
    mockListAgentProviders.mockReturnValue(['openai']);
    mockGetAgentProviderEnvKeys.mockReturnValue(['OPENAI_API_KEY']);
    useStoredCredential(null);

    await expect(readProviderCredential('openai')).resolves.toBeUndefined();
  });

  it('a malformed AWS_REGION still activates — the FACTORY owns the format rejection', async () => {
    // Refusing to activate here would read as "Bedrock is not configured",
    // hiding a fixable typo behind a wrong diagnosis.
    process.env['AWS_REGION'] = 'evil.example.com/';
    process.env['AWS_PROFILE'] = 'acme-dev';
    useStoredCredential(null);

    await expect(readProviderCredential('bedrock')).resolves.toMatchObject({
      mode: 'profile_chain',
      region: 'evil.example.com/',
    });
  });

  it('inspectProviderKeys reports the WINNING mode so the badge cannot lie', async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_PROFILE'] = 'acme-dev';
    useStoredCredential(null);

    await expect(inspectProviderKeys()).resolves.toEqual({
      configuredProviders: [
        { authMode: 'profile_chain', envVar: 'AWS_PROFILE', provider: 'bedrock', source: 'env' },
      ],
      readFailures: [],
    });
  });

  it('a LEGACY bare-string api_key under bedrock is bearer-shaped and outranks the env chain', async () => {
    // PR #2525 review, finding 6. Every pre-BST-1348 stored key is a bare
    // string that parses as `{type:'api_key'}` — including one saved under
    // bedrock. `readProviderCredential` already treats it as a bearer (via
    // isBearerCredential), so inspection must agree; otherwise the badge
    // would announce a profile chain while the run signs with the stored key.
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_PROFILE'] = 'acme-dev';
    useStoredCredential({ key: 'legacy-bedrock-bearer', type: 'api_key' });

    await expect(readProviderCredential('bedrock')).resolves.toMatchObject({
      key: 'legacy-bedrock-bearer',
      source: 'stored',
      type: 'api_key',
    });
    await expect(inspectProviderKeys()).resolves.toEqual({
      configuredProviders: [{ authMode: 'bearer', provider: 'bedrock', source: 'stored' }],
      readFailures: [],
    });
  });

  it('inspectProviderKeys AGREES with readProviderCredential when a stored bearer outranks the env chain', async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_PROFILE'] = 'acme-dev';
    useStoredCredential({
      bearerKey: 'stored-bearer',
      mode: 'bearer',
      region: 'eu-west-1',
      type: 'aws',
    });

    const inspection = await inspectProviderKeys();
    expect(inspection.configuredProviders).toEqual([
      { authMode: 'bearer', provider: 'bedrock', source: 'stored' },
    ]);
    // The listing's verdict and the request path's verdict must never differ,
    // or the badge would name a mode the next run does not use.
    await expect(readProviderCredential('bedrock')).resolves.toMatchObject({ mode: 'bearer' });
  });

  it('NO SILENT FALLBACK: an unreadable stored credential SURFACES instead of activating the env chain', async () => {
    // PR #2529 review, finding 1. The store read failing is NOT the same as
    // "nothing stored": the unreadable entry may be a stored BEARER, which
    // OUTRANKS the env chain. The resolver cannot know which, so signing with
    // an ambient AWS identity here would silently authenticate as somebody
    // the user never chose. Surface the failure; let Settings repair it.
    const { SecretReadError } = await import('../../secrets');
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_PROFILE'] = 'acme-dev';
    mockGetSecretsService.mockReturnValue({
      getCredential: vi.fn().mockRejectedValue(new SecretReadError('decrypt_failed', 'bedrock')),
      listProviders: vi.fn().mockResolvedValue(['bedrock']),
    });

    let thrown: unknown;
    try {
      await readProviderCredential('bedrock');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SecretReadError);
    // The failure must stay CLASSIFIABLE, because that structural match is
    // exactly what the HTTP layer turns into the `api_key_unreadable` 400
    // (packages/assistant-service/src/secret-errors.ts) and what Settings
    // renders as repair guidance.
    expect(matchSecretReadError(thrown)).toMatchObject({
      code: 'decrypt_failed',
      provider: 'bedrock',
    });
  });

  it('inspectProviderKeys AGREES: an unreadable stored credential is NOT relabelled as an env chain', async () => {
    // Same finding, listing side. `applyEnvChainSources` runs after the store
    // read, so without this it would stamp `profile_chain` onto a provider
    // whose stored credential could not be read — announcing a mode the next
    // request now refuses to use, next to a read failure for the same row.
    const { SecretReadError } = await import('../../secrets');
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_PROFILE'] = 'acme-dev';
    mockGetSecretsService.mockReturnValue({
      getCredential: vi.fn().mockRejectedValue(new SecretReadError('decrypt_failed', 'bedrock')),
      listProviders: vi.fn().mockResolvedValue(['bedrock']),
    });

    await expect(inspectProviderKeys()).resolves.toEqual({
      configuredProviders: [],
      readFailures: [{ code: 'decrypt_failed', message: expect.any(String), provider: 'bedrock' }],
    });
  });

  it('an ENV BEARER still short-circuits ahead of an unreadable store (rung 1 never reads it)', async () => {
    // The healthy precedence must not regress: env is authoritative, so the
    // store is never even consulted and there is no failure to surface.
    const { SecretReadError } = await import('../../secrets');
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_PROFILE'] = 'acme-dev';
    process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'env-bearer';
    const getCredential = vi
      .fn()
      .mockRejectedValue(new SecretReadError('decrypt_failed', 'bedrock'));
    mockGetSecretsService.mockReturnValue({
      getCredential,
      listProviders: vi.fn().mockResolvedValue(['bedrock']),
    });

    await expect(readProviderCredential('bedrock')).resolves.toMatchObject({
      key: 'env-bearer',
      source: 'env',
      type: 'api_key',
    });
    expect(getCredential).not.toHaveBeenCalled();
  });
});
