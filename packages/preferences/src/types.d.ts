export {};

declare global {
  /** Which store supplies one credential. Names only — never a key value. */
  interface SecretSourceDescriptor {
    /** Environment variable NAME, present only when `source` is 'env'. */
    envVar?: string;
    provider: string;
    source: 'env' | 'stored';
  }

  /** One environment file this launch rejected whole (strict parse failure). */
  interface SecretsEnvFileError {
    filePath: string;
    line: number | null;
    message: string;
  }

  interface Window {
    secrets?: {
      saveKey: (
        provider: string,
        value: string
      ) => Promise<true | { ok: false; error: 'encryption_unavailable' | 'unknown_error' }>;
      getKey: (provider: string) => Promise<string | null>;
      deleteKey: (provider: string) => Promise<boolean>;
      list: () => Promise<string[]>;
      listStored: () => Promise<string[]>;
      /**
       * Desktop-only per-credential source listing. Capability-checked by
       * callers: absent on older bridges, which fall back to `listStored`.
       */
      describe?: () => Promise<{
        entries: SecretSourceDescriptor[];
        envFileErrors: SecretsEnvFileError[];
      }>;
      clearAll: (confirmationToken?: string) => Promise<{ success: boolean; message?: string }>;
    };
  }
}
