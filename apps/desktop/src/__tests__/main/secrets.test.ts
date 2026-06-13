import { afterEach, describe, expect, it, vi } from 'vitest';

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
}));

vi.mock('electron', () => ({
  safeStorage: safeStorageMock,
}));

import { createSecretsService } from '../../secrets';

type StoreRecord = Record<string, unknown>;

const createStore = () => {
  const data: StoreRecord = {};
  return {
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
    data,
  };
};

describe('secrets', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('stores and retrieves encrypted secrets when available', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockReturnValue(Buffer.from('cipher'));
    safeStorageMock.decryptString.mockReturnValue('decoded');

    const store = createStore();
    const service = createSecretsService(store as never);

    await service.saveKey('openai', 'secret');

    const secrets = store.data['secrets'] as Record<string, string>;
    expect(secrets.openai).toBe(Buffer.from('cipher').toString('base64'));

    const value = await service.getKey('openai');
    expect(value).toBe('decoded');
  });

  it('rejects saving secrets when platform encryption is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    const store = createStore();
    const service = createSecretsService(store as never);

    await expect(service.saveKey('openai', 'secret')).rejects.toThrow('encryption_unavailable');
    expect(store.data['secrets']).toBeUndefined();
  });

  it('does not fall back to base64 decode when decryption fails', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('decrypt failed');
    });

    const store = createStore();
    store.set('secrets', {
      openai: Buffer.from('plain', 'utf-8').toString('base64'),
    });

    const service = createSecretsService(store as never);
    const value = await service.getKey('openai');

    expect(value).toBeNull();
  });

  it('deletes, lists, and clears secrets', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value));

    const store = createStore();
    const service = createSecretsService(store as never);

    await service.saveKey('openai', 'secret');
    await service.saveKey('anthropic', 'secret2');

    expect(await service.listProviders()).toEqual(['openai', 'anthropic']);

    expect(await service.deleteKey('missing')).toBe(false);
    expect(await service.deleteKey('openai')).toBe(true);
    expect(await service.listProviders()).toEqual(['anthropic']);

    expect(await service.clearAll()).toBe(true);
    expect(await service.listProviders()).toEqual([]);
  });

  it('returns false when clearAll fails', async () => {
    const store = createStore();
    const failingStore = {
      get: store.get,
      set: () => {
        throw new Error('fail');
      },
    };

    const service = createSecretsService(failingStore as never);
    await expect(service.clearAll()).resolves.toBe(false);
  });
});
