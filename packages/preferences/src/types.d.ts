export {};

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Interface required for global declaration merging - types cannot be merged
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
      clearAll: (confirmationToken?: string) => Promise<{ success: boolean; message?: string }>;
    };
  }
}
