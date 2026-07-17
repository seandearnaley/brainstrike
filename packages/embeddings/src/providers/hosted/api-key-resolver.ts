import type { HostedProviderType } from '../../provider-types';

type HostedProvider = HostedProviderType;

const ENV_KEYS: Record<HostedProvider, readonly string[]> = {
  cohere: ['COHERE_API_KEY', 'AI_COHERE_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'AI_GOOGLE_API_KEY'],
  lmstudio: ['LMSTUDIO_API_KEY', 'AI_LMSTUDIO_API_KEY'],
  // Optional auth for local OpenAI-compatible runtimes.
  ollama: ['OLLAMA_API_KEY', 'AI_OLLAMA_API_KEY'],
  openai: [
    'BRAINSTRIKE_OPENAI_API_KEY',
    'BS_OPENAI_API_KEY',
    'OPENAI_API_KEY',
    'AI_OPENAI_API_KEY',
    'OPENAI_API_KEY_V1',
    'OPENAI_API_KEY_V2',
  ],
  voyage: ['VOYAGE_API_KEY', 'AI_VOYAGE_API_KEY'],
};

const apiKeyCache = new Map<HostedProvider, string | undefined>();

export async function resolveHostedProviderApiKey(
  provider: HostedProvider
): Promise<string | undefined> {
  const cached = apiKeyCache.get(provider);
  if (cached !== undefined) {
    return cached;
  }

  const fromSecrets = await readFromSecrets(provider);
  if (fromSecrets) {
    apiKeyCache.set(provider, fromSecrets);
    return fromSecrets;
  }

  const fromProcess = readFromProcessEnv(provider);
  if (fromProcess) {
    apiKeyCache.set(provider, fromProcess);
    return fromProcess;
  }

  const fromImportMeta = readFromImportMetaEnv(provider);
  if (fromImportMeta) {
    apiKeyCache.set(provider, fromImportMeta);
    return fromImportMeta;
  }

  apiKeyCache.set(provider, undefined);
  return;
}

export function clearHostedProviderApiKeyCache(provider?: HostedProvider): void {
  if (provider) {
    apiKeyCache.delete(provider);
  } else {
    apiKeyCache.clear();
  }
}

async function readFromSecrets(provider: HostedProvider): Promise<string | undefined> {
  try {
    if (typeof window !== 'undefined') {
      const secretsApi = (
        window as Window & {
          secrets?: { getKey?: (id: string) => Promise<string | null> };
        }
      ).secrets;
      if (secretsApi?.getKey) {
        const value = await secretsApi.getKey(provider);
        return normalizeValue(value);
      }
    }
  } catch {
    // Ignore preload/bridge errors and continue to other sources.
  }
  return;
}

function readFromProcessEnv(provider: HostedProvider): string | undefined {
  try {
    if (typeof process !== 'undefined' && process?.env) {
      for (const key of ENV_KEYS[provider] ?? []) {
        const value = normalizeValue(process.env[key]);
        if (value) {
          return value;
        }
      }
      // Also check VITE_ prefixed variants for SSR builds.
      for (const key of ENV_KEYS[provider] ?? []) {
        const viteKey = `VITE_${key}`;
        const value = normalizeValue(process.env[viteKey]);
        if (value) {
          return value;
        }
      }
    }
  } catch {
    // Ignore access errors
  }
  return;
}

function readFromImportMetaEnv(provider: HostedProvider): string | undefined {
  try {
    const meta = (import.meta as unknown as { env?: Record<string, string | undefined> })?.env;
    if (!meta) {
      return;
    }
    for (const key of ENV_KEYS[provider] ?? []) {
      const value = normalizeValue(meta[key]);
      if (value) {
        return value;
      }
      const viteKey = `VITE_${key}`;
      const viteValue = normalizeValue(meta[viteKey]);
      if (viteValue) {
        return viteValue;
      }
    }
  } catch {
    // import.meta may not exist in CJS contexts
  }
  return;
}

function normalizeValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
