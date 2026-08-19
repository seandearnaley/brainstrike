import {
  resolveHostedProviderKey,
  SECRETS_CHANGED_EVENT_NAME,
} from '@brainstrike/assistant-contract/provider-key-resolution';
import {
  providerDeprecatedEnvKeys,
  providerEnvKeys,
  providerVendorEnvKey,
} from '@brainstrike/assistant-contract/provider-metadata';
import type { HostedProviderType } from '../../provider-types.js';

type HostedProvider = HostedProviderType;

/**
 * Embedding-provider env-var names. Registry-keyed providers derive their
 * names from the shared provider registry (BST-1361) — no hand-maintained
 * copy, so `deprecatedEnvKeys` can never authenticate here. Only the local
 * OpenAI-compatible runtimes (absent from the registry's envKeys because
 * their optional bearer token is a transport concern, not an authType) keep
 * local literals. The RESOLUTION ORDER and error semantics come from the
 * shared core (BST-979): environment sources are authoritative, the secret
 * store is the fallback. Each name is also checked with a `VITE_` prefix for
 * SSR/renderer builds.
 */
export const HOSTED_PROVIDER_ENV_KEYS: Record<HostedProvider, readonly string[]> = {
  cohere: providerEnvKeys('cohere'),
  google: providerEnvKeys('google'),
  lmstudio: ['LMSTUDIO_API_KEY', 'AI_LMSTUDIO_API_KEY'],
  // Optional auth for local OpenAI-compatible runtimes.
  ollama: ['OLLAMA_API_KEY', 'AI_OLLAMA_API_KEY'],
  openai: providerEnvKeys('openai'),
  voyage: providerEnvKeys('voyage'),
};

function envKeyNamesWithViteVariants(provider: HostedProvider): readonly string[] {
  const names = HOSTED_PROVIDER_ENV_KEYS[provider] ?? [];
  return [...names, ...names.map((name) => `VITE_${name}`)];
}

export interface DeprecatedHostedEnvNameHit {
  readonly envVar: string;
  readonly replacement: string;
}

/**
 * Deprecated env names (BST-1361) currently SET in this runtime's env
 * sources for a hosted provider, plain and `VITE_`-prefixed — the same
 * prefix rule the resolver applies to canonical names, so a renderer/SSR
 * build that once authenticated via `VITE_GOOGLE_API_KEY` gets rename
 * guidance instead of a silent death. Detection only: these names NEVER
 * resolve a key. Names only — values never leave this function.
 */
export function detectDeprecatedHostedProviderEnvNames(
  provider: HostedProvider
): readonly DeprecatedHostedEnvNameHit[] {
  const vendorName = providerVendorEnvKey(provider);
  if (!vendorName) {
    return [];
  }
  const candidates = providerDeprecatedEnvKeys(provider).flatMap((name) => [
    { envVar: name, replacement: vendorName },
    { envVar: `VITE_${name}`, replacement: `VITE_${vendorName}` },
  ]);
  if (candidates.length === 0) {
    return [];
  }
  const candidateNames = candidates.map(({ envVar }) => envVar);
  const sources = [
    snapshotEnvSource(readProcessEnv(), candidateNames),
    snapshotEnvSource(readImportMetaEnv(), candidateNames),
  ];
  return candidates.filter(({ envVar }) =>
    sources.some((source) => {
      const value = source?.[envVar];
      return typeof value === 'string' && value.trim().length > 0;
    })
  );
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
