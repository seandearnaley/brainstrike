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

import { matchSecretReadError, SECRET_READ_ERROR_CODES } from '@brainstrike/assistant-contract';
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
