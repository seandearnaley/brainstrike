import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';

declare global {
  interface Window {
    secrets?: {
      saveKey: (
        provider: string,
        value: string
      ) => Promise<true | { ok: false; error: 'encryption_unavailable' | 'unknown_error' }>;
      getKey: (provider: string) => Promise<string | null>;
      deleteKey: (provider: string) => Promise<boolean>;
      list: () => Promise<ProviderKeySource<SupportedProvider | 'tavily'>[]>;
      listStored: () => Promise<string[]>;
      clearAll: (confirmationToken?: string) => Promise<{ success: boolean; message?: string }>;
    };
  }
}
