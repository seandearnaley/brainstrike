import {
  resolveHostedProviderKey,
  SECRETS_CHANGED_EVENT_NAME,
} from '@brainstrike/assistant-contract/provider-key-resolution';
import type { HostedProviderType } from '../../provider-types';

type HostedProvider = HostedProviderType;

/**
 * Embedding-provider env-var names. This is a deliberately separate table
 * from the contract's LLM `providerEnvKeys` — the provider unions differ
 * (cohere/voyage are embedding-only) — but the RESOLUTION ORDER and error
 * semantics come from the shared core (BST-979): environment sources are
 * authoritative, the secret store is the fallback. Each name is also checked
 * with a `VITE_` prefix for SSR/renderer builds.
 */
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

function envKeyNamesWithViteVariants(provider: HostedProvider): readonly string[] {
  const names = ENV_KEYS[provider] ?? [];
  return [...names, ...names.map((name) => `VITE_${name}`)];
}

/**
 * Snapshot the requested names out of a live env map. Capability handling
 * lives HERE, at source acquisition (per the core's contract): renderer env
 * maps can be delegating proxies (vitest's import.meta.env reads through to
 * process.env and throws when process is absent), and a name that cannot be
 * read from such a proxy is a capability absence for that name — the core
 * itself never swallows a read.
 */
function snapshotEnvSource(
  source: Record<string, string | undefined> | undefined,
  names: readonly string[]
): Record<string, string | undefined> | undefined {
  if (!source) {
    return;
  }
  const snapshot: Record<string, string | undefined> = {};
  for (const name of names) {
    try {
      snapshot[name] = source[name];
    } catch {
      // Unreadable name on a proxy source: absent for this name.
    }
  }
  return snapshot;
}

function readProcessEnv(): Record<string, string | undefined> | undefined {
  try {
    return typeof process === 'undefined' ? undefined : process?.env;
  } catch {
    return;
  }
}

function readImportMetaEnv(): Record<string, string | undefined> | undefined {
  try {
    return (import.meta as unknown as { env?: Record<string, string | undefined> })?.env;
  } catch {
    // import.meta may not exist in CJS contexts.
    return;
  }
}

async function readWindowSecret(provider: HostedProvider): Promise<string | null | undefined> {
  // Bridge absence or failure is a CAPABILITY state in the renderer, not a
  // credential error — the web build has no secrets bridge at all. The
  // desktop retrieval path, which does treat read failures as significant,
  // resolves through its own secret store, not this one.
  try {
    if (typeof window === 'undefined') {
      return;
    }
    const secretsApi = (
      window as Window & {
        secrets?: { getKey?: (id: string) => Promise<string | null> };
      }
    ).secrets;
    if (!secretsApi?.getKey) {
      return;
    }
    return await secretsApi.getKey(provider);
  } catch {
    return;
  }
}

/**
 * Positive-result cache only (BST-979): the old cache also stored
 * `undefined`, so a key ADDED after the first miss stayed invisible for the
 * process lifetime. Invalidated by the shared secrets-changed DOM event.
 */
const apiKeyCache = new Map<HostedProvider, string>();

// Latch by window IDENTITY, not a boolean: this module's own suite swaps
// `globalThis.window` per test, and a boolean latch would silently disable
// invalidation for every window after the first.
let wiredWindow: unknown = null;
function wireCacheInvalidation(): void {
  if (typeof window === 'undefined' || wiredWindow === window) {
    return;
  }
  // Capability guard: test doubles stub `window` as a bare object. NOTE the
  // windowless case is load-bearing in Electron MAIN (desktop retrieval's
  // env leg): there the cache can only ever hold process-env reads, which
  // are stable after main-bootstrap's env-file load — if this resolver ever
  // gains a non-env source reachable from main, that invariant breaks and
  // main needs its own invalidation path.
  if (typeof window.addEventListener !== 'function') {
    return;
  }
  wiredWindow = window;
  window.addEventListener(SECRETS_CHANGED_EVENT_NAME, () => {
    apiKeyCache.clear();
  });
}

export async function resolveHostedProviderApiKey(
  provider: HostedProvider
): Promise<string | undefined> {
  wireCacheInvalidation();
  const cached = apiKeyCache.get(provider);
  if (cached !== undefined) {
    return cached;
  }

  const envKeyNames = envKeyNamesWithViteVariants(provider);
  const resolution = await resolveHostedProviderKey({
    envKeyNames,
    envSources: [
      snapshotEnvSource(readProcessEnv(), envKeyNames),
      snapshotEnvSource(readImportMetaEnv(), envKeyNames),
    ],
    readSecret: () => readWindowSecret(provider),
  });
  if (resolution.key) {
    apiKeyCache.set(provider, resolution.key);
  }
  return resolution.key;
}

export function clearHostedProviderApiKeyCache(provider?: HostedProvider): void {
  if (provider) {
    apiKeyCache.delete(provider);
  } else {
    apiKeyCache.clear();
  }
}
