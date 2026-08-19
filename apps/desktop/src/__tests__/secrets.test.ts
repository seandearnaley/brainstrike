import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorageMock = vi.hoisted(() => ({
  decryptString: vi.fn<(buf: Buffer) => string>(),
  encryptString: vi.fn<(value: string) => Buffer>(),
  getSelectedStorageBackend: vi.fn<() => string>(),
  isEncryptionAvailable: vi.fn<() => boolean>(),
}));

vi.mock('electron', () => ({
  safeStorage: safeStorageMock,
}));

vi.mock('electron-store', () => ({ default: class {} }));

import {
  matchSecretReadError,
  type ProviderCredential,
  SECRET_READ_ERROR_CODES,
} from '@brainstrike/assistant-contract';
import { getSecretReadErrorPayload } from '@brainstrike/assistant-service/secret-errors';
import { createSecretsService, SecretReadError } from '../secrets';

interface FakeStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

function fakeStore(initial: Record<string, string> = {}): FakeStore {
  const data: { secrets: Record<string, string> } = { secrets: { ...initial } };
  return {
    get: (key: string) => (key === 'secrets' ? data.secrets : undefined),
    set: (key: string, value: unknown) => {
      if (key === 'secrets') {
        data.secrets = value as Record<string, string>;
      }
    },
  };
}

const service = (store: FakeStore) =>
  createSecretsService(store as unknown as Parameters<typeof createSecretsService>[0]);

describe('secrets getKey failure surfacing (BST-574)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('keychain');
  });

  it('resolves null when the provider has no stored secret', async () => {
    await expect(service(fakeStore()).getKey('openai')).resolves.toBeNull();
  });

  it('decrypts a stored secret on the happy path', async () => {
    safeStorageMock.decryptString.mockReturnValue('sk-test');
    const stored = Buffer.from('ciphertext').toString('base64');

    await expect(service(fakeStore({ openai: stored })).getKey('openai')).resolves.toBe('sk-test');
  });

  it('throws a typed decrypt_failed error for a corrupt stored secret (never null)', async () => {
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('bad ciphertext');
    });
    const stored = Buffer.from('garbage').toString('base64');

    const attempt = service(fakeStore({ openai: stored })).getKey('openai');
    await expect(attempt).rejects.toBeInstanceOf(SecretReadError);
    await expect(service(fakeStore({ openai: stored })).getKey('openai')).rejects.toMatchObject({
      code: 'decrypt_failed',
      provider: 'openai',
    });
  });

  it('throws a typed encryption_unavailable error when a secret exists but the backend is unusable', async () => {
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text');
    const stored = Buffer.from('ciphertext').toString('base64');

    await expect(
      service(fakeStore({ anthropic: stored })).getKey('anthropic')
    ).rejects.toMatchObject({
      code: 'encryption_unavailable',
      provider: 'anthropic',
    });
  });

  it('still resolves null (not a throw) when encryption is unusable but nothing is stored', async () => {
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text');

    await expect(service(fakeStore()).getKey('openai')).resolves.toBeNull();
  });
});

/**
 * Wires the safeStorage mock as a reversible fake so values round-trip:
 * encryptString prefixes plaintext, decryptString strips the prefix.
 */
function useRoundTripSafeStorage(): void {
  safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(`enc:${value}`));
  safeStorageMock.decryptString.mockImplementation((buf: Buffer) => {
    const text = buf.toString('utf8');
    if (!text.startsWith('enc:')) {
      throw new Error('not ciphertext');
    }
    return text.slice('enc:'.length);
  });
}

describe('typed provider credentials (BST-1348)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('keychain');
    useRoundTripSafeStorage();
  });

  describe('legacy bare-string compatibility', () => {
    it('reads a pre-change raw stored value identically through getKey AND getCredential', async () => {
      // Fixture: exactly what the pre-BST-1348 saveKey wrote — the encrypted
      // bare string, base64-encoded. No JSON anywhere.
      const preChangeStored = Buffer.from('enc:sk-legacy-raw').toString('base64');
      const svc = service(fakeStore({ openai: preChangeStored }));

      await expect(svc.getKey('openai')).resolves.toBe('sk-legacy-raw');
      await expect(svc.getCredential('openai')).resolves.toEqual({
        key: 'sk-legacy-raw',
        type: 'api_key',
      });
    });

    it('getKey on a value saved through the string saveKey keeps returning the raw string', async () => {
      const store = fakeStore();
      const svc = service(store);
      await svc.saveKey('anthropic', 'sk-ant-raw');

      await expect(svc.getKey('anthropic')).resolves.toBe('sk-ant-raw');
      await expect(svc.getCredential('anthropic')).resolves.toEqual({
        key: 'sk-ant-raw',
        type: 'api_key',
      });
    });

    it('saveKey round-trips a string that IS a JSON object with an unrecognized type (GCP service-account JSON)', async () => {
      // saveKey stores the api_key JSON ENVELOPE (single write path via
      // setCredential), so a pasted GCP service-account JSON — which carries
      // "type":"service_account" — must come back verbatim instead of
      // hard-failing the tagged-credential validation on read.
      const gcpServiceAccountJson = '{"type":"service_account","project_id":"p","private_key":"k"}';
      const svc = service(fakeStore());

      await expect(svc.saveKey('vertex', gcpServiceAccountJson)).resolves.toBe(true);
      await expect(svc.getKey('vertex')).resolves.toBe(gcpServiceAccountJson);
      await expect(svc.getCredential('vertex')).resolves.toEqual({
        key: gcpServiceAccountJson,
        type: 'api_key',
      });
    });

    it('saveKey rejects an empty key through the same validator as setCredential', async () => {
      await expect(service(fakeStore()).saveKey('openai', '')).rejects.toThrow(
        /malformed|invalid/i
      );
    });
  });

  describe('setCredential / getCredential round-trips', () => {
    const credentials: readonly ProviderCredential[] = [
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

    it.each(credentials.map((credential) => [credential.type, credential] as const))(
      'round-trips a %s credential through the store',
      async (_type, credential) => {
        const store = fakeStore();
        const svc = service(store);

        await expect(svc.setCredential('anthropic', credential)).resolves.toBe(true);
        await expect(svc.getCredential('anthropic')).resolves.toEqual(credential);
      }
    );

    it('resolves null (not a throw) when no credential is stored', async () => {
      await expect(service(fakeStore()).getCredential('openai')).resolves.toBeNull();
    });

    it('setCredential rejects a malformed credential object instead of storing it', async () => {
      const store = fakeStore();
      const svc = service(store);
      const invalid = { type: 'oauth' } as unknown as ProviderCredential;

      await expect(svc.setCredential('anthropic', invalid)).rejects.toThrow(/malformed|invalid/i);
      await expect(svc.getCredential('anthropic')).resolves.toBeNull();
    });

    it('setCredential surfaces encryption_unavailable instead of storing plaintext', async () => {
      safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text');
      const svc = service(fakeStore());

      await expect(svc.setCredential('anthropic', { key: 'sk', type: 'api_key' })).rejects.toThrow(
        'encryption_unavailable'
      );
    });
  });

  describe('read-path failures stay typed (never coerced)', () => {
    it('getCredential throws SecretReadError(malformed_credential) for a stored unrecognized type', async () => {
      const stored = Buffer.from('enc:{"type":"gcp","key":"x"}').toString('base64');
      const attempt = service(fakeStore({ openai: stored })).getCredential('openai');

      await expect(attempt).rejects.toBeInstanceOf(SecretReadError);
      await expect(
        service(fakeStore({ openai: stored })).getCredential('openai')
      ).rejects.toMatchObject({ code: 'malformed_credential', provider: 'openai' });
    });

    it('getCredential throws SecretReadError(malformed_credential) for a recognized type with missing fields', async () => {
      const stored = Buffer.from('enc:{"type":"oauth"}').toString('base64');

      await expect(
        service(fakeStore({ openai: stored })).getCredential('openai')
      ).rejects.toMatchObject({ code: 'malformed_credential', provider: 'openai' });
    });

    it('getKey ALSO surfaces malformed_credential for a tagged-but-invalid stored value', async () => {
      const stored = Buffer.from('enc:{"type":"gcp","key":"x"}').toString('base64');

      await expect(service(fakeStore({ openai: stored })).getKey('openai')).rejects.toMatchObject({
        code: 'malformed_credential',
        provider: 'openai',
      });
    });

    it('getCredential preserves the decrypt_failed / encryption_unavailable distinction', async () => {
      const undecryptable = Buffer.from('garbage-not-prefixed').toString('base64');
      await expect(
        service(fakeStore({ openai: undecryptable })).getCredential('openai')
      ).rejects.toMatchObject({ code: 'decrypt_failed', provider: 'openai' });

      safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text');
      const stored = Buffer.from('enc:whatever').toString('base64');
      await expect(
        service(fakeStore({ anthropic: stored })).getCredential('anthropic')
      ).rejects.toMatchObject({ code: 'encryption_unavailable', provider: 'anthropic' });
    });
  });

  describe('getKey on a non-api_key credential stays inside the SecretReadError contract', () => {
    it('throws SecretReadError(credential_type_unsupported), never a stringified credential', async () => {
      const store = fakeStore();
      const svc = service(store);
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
    });

    it('credential_type_unsupported flows through the HTTP payload shaping as api_key_unreadable', () => {
      // Consequence (b) of the SecretReadError contract: the assistant server's
      // secret-error responder classifies structurally via matchSecretReadError,
      // so a typed-credential read through getKey must produce the structured
      // api_key_unreadable 400 instead of an unclassified 500.
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
      const svc = service(fakeStore());
      await svc.setCredential('openai', { key: 'sk-typed', type: 'api_key' });

      await expect(svc.getKey('openai')).resolves.toBe('sk-typed');
    });
  });

  describe('factory reset coverage', () => {
    it('clearAll wipes a stored oauth credential (guards factory-reset divergence)', async () => {
      const store = fakeStore();
      const svc = service(store);
      await svc.setCredential('anthropic', {
        access: 'at-1',
        expires: 1,
        refresh: 'rt-1',
        type: 'oauth',
      });
      await expect(svc.getCredential('anthropic')).resolves.toMatchObject({ type: 'oauth' });

      await expect(svc.clearAll()).resolves.toBe(true);

      await expect(svc.getCredential('anthropic')).resolves.toBeNull();
      await expect(svc.listProviders()).resolves.toEqual([]);
    });

    it('clearAll wipes an ENGINE-written oauth credential (BST-1355: factory reset covers the OAuth engine)', async () => {
      // Persist through the engine's own credential projection so this guard
      // tracks the exact shape the OAuth engine writes (including accountId),
      // not a hand-rolled approximation.
      const { toStoredOAuthCredential } = await import('../provider-auth/oauth-flow');
      const store = fakeStore();
      const svc = service(store);
      const credential = toStoredOAuthCredential(
        {
          accessToken: 'engine-access-token',
          expiresInSeconds: 3600,
          raw: { account_id: 'acct-9' },
          refreshToken: 'engine-refresh-token',
        },
        { accountId: 'acct-9', now: 1_700_000_000_000 }
      );
      await svc.setCredential('fake-oauth-provider', credential);
      await expect(svc.getCredential('fake-oauth-provider')).resolves.toEqual(credential);

      await expect(svc.clearAll()).resolves.toBe(true);

      await expect(svc.getCredential('fake-oauth-provider')).resolves.toBeNull();
      await expect(svc.listProviders()).resolves.toEqual([]);
    });
  });
});

describe('SecretReadError structural conformance (BST-972 A3)', () => {
  // MONEY TEST for the cross-package contract: server modules classify these
  // failures via assistant-contract's STRUCTURAL matchSecretReadError instead
  // of instanceof. A rename of `name`/`code`/`provider` on the class would
  // compile fine and silently stop every classifier from matching — this is
  // the test that goes red instead. Driven per code because the constructor's
  // detail branch treats the codes asymmetrically.
  it.each(SECRET_READ_ERROR_CODES)(
    'the real class matches assistant-contract matchSecretReadError (%s)',
    (code) => {
      const error = new SecretReadError(code, 'openai');
      // The matcher keys on the `name` OWN property — `this.name = ...` in the
      // constructor. Asserted directly because it is the field most likely to
      // be dropped by an unrelated refactor (constructor.name does NOT cover
      // it after minification).
      expect(error.name).toBe('SecretReadError');
      expect(matchSecretReadError(error)).toEqual({
        code,
        message: error.message,
        provider: 'openai',
      });
    }
  );
});
