import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorageMock = vi.hoisted(() => ({
  decryptString: vi.fn<(buf: Buffer) => string>(),
  getSelectedStorageBackend: vi.fn<() => string>(),
  isEncryptionAvailable: vi.fn<() => boolean>(),
}));

const userData = vi.hoisted(() => ({ path: '/unused-in-these-tests' }));

vi.mock('electron', () => ({
  app: { getPath: () => userData.path },
  safeStorage: safeStorageMock,
}));

import {
  matchSecretReadError,
  type ProviderCredential,
  SECRET_READ_ERROR_CODES,
} from '@brainstrike/assistant-contract';
import { getSecretReadErrorPayload } from '@brainstrike/assistant-service/secret-errors';
import {
  createHostCredentials,
  migrateLegacySecrets,
} from '@brainstrike/host-capabilities/credentials';
import {
  createSecretsMcpBearerCredentialAuthority,
  mcpBearerCredentialStorageKey,
} from '../mcp/bearer-credential';
import {
  createSafeStorageLegacySecretSource,
  desktopCredentialStoreSelection,
  SecretReadError,
} from '../secrets';

/**
 * The retired electron-store file inside a disposable profile, in its shipped
 * shape. `undefined` leaves the profile without one (a fresh install).
 */
async function legacyFile(secrets?: Record<string, string>): Promise<string> {
  const file = join(await disposableProfile(), 'brainstrike-secrets.json');
  if (secrets) {
    await writeFile(file, JSON.stringify({ secrets, unrelated: 'kept' }));
  }
  return file;
}

/** What the retired safeStorage service wrote: base64 of the encrypted plaintext. */
function legacyCiphertext(plaintext: string): string {
  return Buffer.from(`enc:${plaintext}`).toString('base64');
}

function useRoundTripSafeStorage(): void {
  safeStorageMock.decryptString.mockImplementation((buf: Buffer) => {
    const text = buf.toString('utf8');
    if (!text.startsWith('enc:')) {
      throw new Error('not ciphertext');
    }
    return text.slice('enc:'.length);
  });
}

const profiles: string[] = [];

async function disposableProfile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bs-desktop-secrets-'));
  profiles.push(directory);
  return directory;
}

/** The desktop secrets service over an isolated profile's private file store. */
async function desktopSecrets() {
  const credentials = createHostCredentials({
    selection: desktopCredentialStoreSelection(await disposableProfile(), true),
  });
  return { credentials, svc: credentials.secrets() };
}

beforeEach(() => {
  vi.clearAllMocks();
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  safeStorageMock.getSelectedStorageBackend.mockReturnValue('keychain');
  useRoundTripSafeStorage();
});

afterEach(async () => {
  for (const directory of profiles.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe('desktop credential store selection', () => {
  it('keeps isolated test profiles on a private file inside the profile', () => {
    expect(desktopCredentialStoreSelection('/profiles/e2e-1', true)).toEqual({
      kind: 'file',
      path: '/profiles/e2e-1/brainstrike-credentials.json',
    });
  });

  it('scopes the production keyring service to the profile', () => {
    expect(desktopCredentialStoreSelection('/Users/me/Library/Brainstrike', false)).toEqual({
      kind: 'keyring',
      service: 'brainstrike-desktop:/Users/me/Library/Brainstrike',
    });
  });
});

describe('retired safeStorage source failure surfacing (BST-574)', () => {
  it('reads an empty store as no entries, even when encryption is unusable', async () => {
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text');
    await expect(
      createSafeStorageLegacySecretSource(await legacyFile(), safeStorageMock).entries()
    ).resolves.toEqual([]);
  });

  it('decrypts every entry under its existing account name', async () => {
    const source = createSafeStorageLegacySecretSource(
      await legacyFile({
        anthropic: legacyCiphertext('{"key":"sk-ant","type":"api_key"}'),
        openai: legacyCiphertext('sk-test'),
      }),
      safeStorageMock
    );
    await expect(source.entries()).resolves.toEqual([
      { account: 'anthropic', value: '{"key":"sk-ant","type":"api_key"}' },
      { account: 'openai', value: 'sk-test' },
    ]);
  });

  it('throws a typed decrypt_failed error for a corrupt stored secret (never skipped)', async () => {
    const source = createSafeStorageLegacySecretSource(
      await legacyFile({ openai: Buffer.from('garbage').toString('base64') }),
      safeStorageMock
    );
    const attempt = source.entries();
    await expect(attempt).rejects.toBeInstanceOf(SecretReadError);
    await expect(attempt).rejects.toMatchObject({ code: 'decrypt_failed', provider: 'openai' });
  });

  it.each(['basic_text', 'unavailable'])(
    'throws a typed encryption_unavailable error when a secret exists but the backend is %s',
    async (backend) => {
      if (backend === 'basic_text') {
        safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text');
      } else {
        safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
      }
      const source = createSafeStorageLegacySecretSource(
        await legacyFile({ anthropic: legacyCiphertext('sk') }),
        safeStorageMock
      );
      await expect(source.entries()).rejects.toMatchObject({
        code: 'encryption_unavailable',
        provider: 'anthropic',
      });
    }
  );

  it('retires the legacy store only through the migration, after the copy is verified', async () => {
    const legacy = await legacyFile({ openai: legacyCiphertext('sk-legacy-raw') });
    const { credentials, svc } = await desktopSecrets();
    await expect(
      migrateLegacySecrets({
        destination: credentials.store(),
        source: createSafeStorageLegacySecretSource(legacy, safeStorageMock),
      })
    ).resolves.toEqual({ alreadyPresent: 0, migrated: 1 });
    expect(JSON.parse(await readFile(legacy, 'utf8'))).toEqual({ secrets: {}, unrelated: 'kept' });
    await expect(svc.getKey('openai')).resolves.toBe('sk-legacy-raw');
    await credentials.close();
  });
});

describe('typed provider credentials (BST-1348)', () => {
  describe('legacy bare-string compatibility', () => {
    it('reads a migrated pre-change raw value identically through getKey AND getCredential', async () => {
      // Fixture: exactly what the pre-BST-1348 saveKey wrote — the encrypted
      // bare string. No JSON anywhere.
      const { credentials, svc } = await desktopSecrets();
      await migrateLegacySecrets({
        destination: credentials.store(),
        source: createSafeStorageLegacySecretSource(
          await legacyFile({ openai: legacyCiphertext('sk-legacy-raw') }),
          safeStorageMock
        ),
      });

      await expect(svc.getKey('openai')).resolves.toBe('sk-legacy-raw');
      await expect(svc.getCredential('openai')).resolves.toEqual({
        key: 'sk-legacy-raw',
        type: 'api_key',
      });
      await credentials.close();
    });

    it('getKey on a value saved through the string saveKey keeps returning the raw string', async () => {
      const { credentials, svc } = await desktopSecrets();
      await svc.saveKey('anthropic', 'sk-ant-raw');

      await expect(svc.getKey('anthropic')).resolves.toBe('sk-ant-raw');
      await expect(svc.getCredential('anthropic')).resolves.toEqual({
        key: 'sk-ant-raw',
        type: 'api_key',
      });
      await credentials.close();
    });

    it('saveKey round-trips a string that IS a JSON object with an unrecognized type (GCP service-account JSON)', async () => {
      const gcpServiceAccountJson = '{"type":"service_account","project_id":"p","private_key":"k"}';
      const { credentials, svc } = await desktopSecrets();

      await expect(svc.saveKey('vertex', gcpServiceAccountJson)).resolves.toBe(true);
      await expect(svc.getKey('vertex')).resolves.toBe(gcpServiceAccountJson);
      await expect(svc.getCredential('vertex')).resolves.toEqual({
        key: gcpServiceAccountJson,
        type: 'api_key',
      });
      await credentials.close();
    });

    it('saveKey rejects an empty key through the same validator as setCredential', async () => {
      const { credentials, svc } = await desktopSecrets();
      await expect(svc.saveKey('openai', '')).rejects.toThrow(/malformed|invalid/i);
      await credentials.close();
    });
  });

  describe('setCredential / getCredential round-trips', () => {
    const typed: readonly ProviderCredential[] = [
      { key: 'sk-typed', metadata: { org: 'org-1' }, type: 'api_key' },
      {
        access: 'at-1',
        accountId: 'acct-9',
        expires: 1_755_500_000_000,
        refresh: 'rt-1',
        type: 'oauth',
      },
      { bearerKey: 'bedrock-bearer', mode: 'bearer', region: 'us-east-1', type: 'aws' },
      { mode: 'profile_chain', profile: 'work', region: 'eu-west-1', type: 'aws' },
    ];

    it.each(typed.map((credential) => [credential.type, credential] as const))(
      'round-trips a %s credential through the store',
      async (_type, credential) => {
        const { credentials, svc } = await desktopSecrets();
        await expect(svc.setCredential('anthropic', credential)).resolves.toBe(true);
        await expect(svc.getCredential('anthropic')).resolves.toEqual(credential);
        await credentials.close();
      }
    );

    it('resolves null (not a throw) when no credential is stored', async () => {
      const { credentials, svc } = await desktopSecrets();
      await expect(svc.getCredential('openai')).resolves.toBeNull();
      await credentials.close();
    });

    it('setCredential rejects a malformed credential object instead of storing it', async () => {
      const { credentials, svc } = await desktopSecrets();
      const invalid = { type: 'oauth' } as unknown as ProviderCredential;

      await expect(svc.setCredential('anthropic', invalid)).rejects.toThrow(/malformed|invalid/i);
      await expect(svc.getCredential('anthropic')).resolves.toBeNull();
      await credentials.close();
    });
  });

  describe('read-path failures stay typed (never coerced)', () => {
    it.each([
      ['a stored unrecognized type', '{"type":"gcp","key":"x"}'],
      ['a recognized type with missing fields', '{"type":"oauth"}'],
    ])('getCredential and getKey throw malformed_credential for %s', async (_case, raw) => {
      const { credentials, svc } = await desktopSecrets();
      await credentials.store().write('openai', raw);

      await expect(svc.getCredential('openai')).rejects.toBeInstanceOf(SecretReadError);
      await expect(svc.getCredential('openai')).rejects.toMatchObject({
        code: 'malformed_credential',
        provider: 'openai',
      });
      await expect(svc.getKey('openai')).rejects.toMatchObject({
        code: 'malformed_credential',
        provider: 'openai',
      });
      await credentials.close();
    });
  });

  describe('getKey on a non-api_key credential stays inside the SecretReadError contract', () => {
    it('throws SecretReadError(credential_type_unsupported), never a stringified credential', async () => {
      const { credentials, svc } = await desktopSecrets();
      await svc.setCredential('anthropic', {
        access: 'at-1',
        expires: 1,
        refresh: 'rt-1',
        type: 'oauth',
      });

      await expect(svc.getKey('anthropic')).rejects.toBeInstanceOf(SecretReadError);
      await expect(svc.getKey('anthropic')).rejects.toMatchObject({
        code: 'credential_type_unsupported',
        provider: 'anthropic',
      });
      await credentials.close();
    });

    it('credential_type_unsupported flows through the HTTP payload shaping as api_key_unreadable', () => {
      const payload = getSecretReadErrorPayload(
        new SecretReadError('credential_type_unsupported', 'anthropic')
      );
      expect(payload).toMatchObject({
        code: 'credential_type_unsupported',
        error: 'api_key_unreadable',
        provider: 'anthropic',
      });
    });

    it('returns the bare key for a stored typed api_key credential', async () => {
      const { credentials, svc } = await desktopSecrets();
      await svc.setCredential('openai', { key: 'sk-typed', type: 'api_key' });

      await expect(svc.getKey('openai')).resolves.toBe('sk-typed');
      await credentials.close();
    });
  });

  describe('factory reset coverage', () => {
    it('clearAll removes MCP bearer credentials from the shared authority', async () => {
      const reference = {
        id: '00000000-0000-4000-8000-000000000001',
        store: 'mcp-credentials',
      } as const;
      const { credentials, svc } = await desktopSecrets();
      const authority = createSecretsMcpBearerCredentialAuthority(svc);

      await svc.saveKey(mcpBearerCredentialStorageKey(reference), 'factory-reset-secret');
      await expect(authority.inspect(reference)).resolves.toEqual({ state: 'stored' });

      await expect(svc.clearAll()).resolves.toBe(true);
      await expect(authority.inspect(reference)).resolves.toEqual({ state: 'missing' });
      await credentials.close();
    });
  });
});

describe("Main's view of the host-owned profile store", () => {
  /** Main's services over a fresh disposable profile, with its one-time migration settled. */
  async function mainSecrets() {
    userData.path = await disposableProfile();
    vi.resetModules();
    const secrets = await import('../secrets');
    await secrets.migrateDesktopLegacySecrets();
    // The host's own handle on the same profile store.
    const host = createHostCredentials({
      selection: secrets.desktopCredentialStoreSelection(userData.path, true),
    });
    return { host, secrets };
  }

  it('reads host-written keys, refuses every write and never reads subscription tokens', async () => {
    const { host, secrets } = await mainSecrets();
    const signIn: ProviderCredential = {
      access: 'host-held-access',
      expires: Date.now() + 3_600_000,
      refresh: 'host-held-refresh',
      type: 'oauth',
    };
    await host.secrets().setCredential('openai', { key: 'sk-host-written', type: 'api_key' });
    await host.secrets().setCredential('openai-codex', signIn);
    const main = secrets.getSecretsService();

    await expect(main.getKey('openai')).resolves.toBe('sk-host-written');
    await expect(main.listProviders()).resolves.toEqual(
      expect.arrayContaining(['openai', 'openai-codex'])
    );
    await expect(main.getCredential('openai-codex')).rejects.toMatchObject({
      code: 'credential_type_unsupported',
      provider: 'openai-codex',
    });
    for (const write of [
      () => main.saveKey('openai', 'sk-main'),
      () => main.setCredential('openai', { key: 'sk-main', type: 'api_key' }),
      () => main.deleteKey('openai'),
      () => main.clearAll(),
    ]) {
      await expect(write()).rejects.toThrow('the agent host owns every credential write');
    }
    await expect(host.secrets().getCredential('openai-codex')).resolves.toEqual(signIn);
    await host.close();
  });

  it('Settings writes reach the store only through the host writer', async () => {
    const { host, secrets } = await mainSecrets();
    const writer = {
      clear: vi.fn(() => host.secrets().clearAll()),
      deleteCredential: vi.fn((account: string) => host.secrets().deleteKey(account)),
      setCredential: vi.fn(async (account: string, credential: ProviderCredential) => {
        await host.secrets().setCredential(account, credential);
      }),
    };
    const settings = secrets.createDesktopSettingsSecrets(writer);

    await expect(settings.saveKey('openai', 'sk-settings')).resolves.toBe(true);
    expect(writer.setCredential).toHaveBeenCalledWith('openai', {
      key: 'sk-settings',
      type: 'api_key',
    });
    await expect(settings.getKey('openai')).resolves.toBe('sk-settings');
    await expect(
      settings.setCredential('openai-codex', {
        access: 'renderer-supplied',
        expires: Date.now() + 3_600_000,
        refresh: 'renderer-supplied',
        type: 'oauth',
      })
    ).rejects.toThrow('stored only by the host sign-in flow');
    await expect(settings.deleteKey('openai')).resolves.toBe(true);
    await expect(settings.getKey('openai')).resolves.toBeNull();
    await expect(settings.clearAll()).resolves.toBe(true);
    expect(writer.setCredential).toHaveBeenCalledOnce();
    expect(writer.deleteCredential).toHaveBeenCalledWith('openai');
    expect(writer.clear).toHaveBeenCalledOnce();
    await host.close();
  });
});

describe('SecretReadError structural conformance (BST-972 A3)', () => {
  // MONEY TEST for the cross-package contract: server modules classify these
  // failures via assistant-contract's STRUCTURAL matchSecretReadError instead
  // of instanceof. A rename of `name`/`code`/`provider` on the class would
  // compile fine and silently stop every classifier from matching.
  it.each(SECRET_READ_ERROR_CODES)(
    'the real class matches assistant-contract matchSecretReadError (%s)',
    (code) => {
      const error = new SecretReadError(code, 'openai');
      expect(error.name).toBe('SecretReadError');
      expect(matchSecretReadError(error)).toEqual({
        code,
        message: error.message,
        provider: 'openai',
      });
    }
  );
});
