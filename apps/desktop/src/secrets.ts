import { safeStorage } from 'electron';
import ElectronStore from 'electron-store';

export interface SecretsService {
  saveKey(provider: string, value: string): Promise<boolean>;
  getKey(provider: string): Promise<string | null>;
  deleteKey(provider: string): Promise<boolean>;
  listProviders(): Promise<string[]>;
}

interface SecretsSchema {
  secrets: Record<string, string>; // base64-encoded encrypted strings
}

export function createSecretsService(store?: ElectronStore<SecretsSchema>): SecretsService {
  const _store = store ?? new ElectronStore<SecretsSchema>({ name: 'brainstrike-secrets' });
  // Work around ElectronStore Conf typings in TS builds
  const secretsStore = _store as ElectronStore<SecretsSchema> & {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  };

  async function ensureEncryption(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('encryption_unavailable');
    }
  }

  return {
    async saveKey(provider: string, value: string): Promise<boolean> {
      await ensureEncryption();
      const encrypted = safeStorage.encryptString(value); // Buffer
      const b64 = Buffer.from(encrypted).toString('base64');
      const secrets = (secretsStore.get('secrets') as SecretsSchema['secrets']) ?? {};
      secrets[provider] = b64;
      secretsStore.set('secrets', secrets);
      return true;
    },
    async getKey(provider: string): Promise<string | null> {
      const b64 = (secretsStore.get('secrets') as SecretsSchema['secrets'])?.[provider];
      if (!b64) return null;
      try {
        const buf = Buffer.from(b64, 'base64');
        const decrypted = safeStorage.decryptString(buf);
        return decrypted;
      } catch {
        return null;
      }
    },
    async deleteKey(provider: string): Promise<boolean> {
      const secrets = (secretsStore.get('secrets') as SecretsSchema['secrets']) ?? {};
      if (provider in secrets) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete secrets[provider];
        secretsStore.set('secrets', secrets);
        return true;
      }
      return false;
    },
    async listProviders(): Promise<string[]> {
      const secrets = (secretsStore.get('secrets') as SecretsSchema['secrets']) ?? {};
      return Object.keys(secrets);
    },
  } satisfies SecretsService;
}
