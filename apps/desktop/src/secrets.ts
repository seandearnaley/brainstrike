import { safeStorage } from 'electron';
import ElectronStore from 'electron-store';

export interface SecretsService {
  saveKey(provider: string, value: string): Promise<boolean>;
  getKey(provider: string): Promise<string | null>;
  deleteKey(provider: string): Promise<boolean>;
  listProviders(): Promise<string[]>;
  clearAll(): Promise<boolean>;
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

  return {
    async saveKey(provider: string, value: string): Promise<boolean> {
      const hasEncryption = Boolean(safeStorage?.isEncryptionAvailable?.());
      const b64 = hasEncryption
        ? Buffer.from(safeStorage.encryptString(value)).toString('base64')
        : Buffer.from(Buffer.from(value, 'utf-8')).toString('base64');
      const secrets = (secretsStore.get('secrets') as SecretsSchema['secrets']) ?? {};
      secrets[provider] = b64;
      secretsStore.set('secrets', secrets);
      return true;
    },
    async getKey(provider: string): Promise<string | null> {
      const b64 = (secretsStore.get('secrets') as SecretsSchema['secrets'])?.[provider];
      if (!b64) {
        return null;
      }
      try {
        const buf = Buffer.from(b64, 'base64');
        // Prefer secure decrypt when available
        if (safeStorage?.isEncryptionAvailable?.()) {
          try {
            return safeStorage.decryptString(buf);
          } catch {
            // fall through to plain decode
          }
        }
        // Plain base64 decode fallback
        return buf.toString('utf-8');
      } catch {
        return null;
      }
    },
    async deleteKey(provider: string): Promise<boolean> {
      const secrets = (secretsStore.get('secrets') as SecretsSchema['secrets']) ?? {};
      if (!Object.hasOwn(secrets, provider)) {
        return false;
      }
      const next = Object.fromEntries(
        Object.entries(secrets).filter(([key]) => key !== provider)
      ) as SecretsSchema['secrets'];
      secretsStore.set('secrets', next);
      return true;
    },
    async listProviders(): Promise<string[]> {
      const secrets = (secretsStore.get('secrets') as SecretsSchema['secrets']) ?? {};
      return Object.keys(secrets);
    },
    async clearAll(): Promise<boolean> {
      try {
        secretsStore.set('secrets', {});
        return true;
      } catch {
        return false;
      }
    },
  } satisfies SecretsService;
}

// Singleton accessor for consumers (e.g., assistant server) without circular DI
let __secretsInstance: SecretsService | null = null;
export function getSecretsService(): SecretsService {
  if (!__secretsInstance) {
    __secretsInstance = createSecretsService();
  }
  return __secretsInstance;
}
