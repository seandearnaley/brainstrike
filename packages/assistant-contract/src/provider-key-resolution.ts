/**
 * The ONE hosted-provider key-resolution core (BST-979 / BST-904 G6).
 *
 * Before this module, three resolvers disagreed on ordering (desktop
 * credentials: env → keychain; retrieval: keychain → env; embeddings:
 * secrets → process.env → import.meta.env with a negative-result cache), so
 * a key rotated in one store could stay shadowed by another indefinitely.
 * Every caller now shares this core with the DOCUMENTED env-authoritative
 * order (docs/agents/assistant-providers.md):
 *
 *   1. environment sources, in caller order, first matching name wins;
 *   2. the platform secret store (keychain / window-secrets bridge).
 *
 * Provider-name tables stay per-domain (LLM providers and embedding
 * providers are different unions) and are INJECTED — this module owns the
 * order and the error semantics, not the tables.
 *
 * SecretReadError escape hatch (BST-574, preserved from the retrieval tool):
 * a secret-store read failure is NOT equivalent to an absent credential. If
 * an env key exists the failure is irrelevant (env is authoritative); if no
 * key exists anywhere the failure must stay visible to the caller, who
 * decides whether to throw or degrade. This function therefore never throws.
 */

export interface HostedKeyResolution {
  readonly key?: string;
  /**
   * A secret-store read failure captured while no key was found anywhere.
   * Never set when `key` is present.
   */
  readonly secretReadError?: unknown;
  /** Where the winning key came from; absent when no key was found. */
  readonly source?: 'env' | 'secrets';
}

export interface ResolveHostedProviderKeyOptions {
  /** Env var names for this provider, checked in order within each source. */
  readonly envKeyNames: readonly string[];
  /** Environment maps, checked in order (e.g. process.env, import.meta.env). */
  readonly envSources: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>;
  /** Platform secret store read; omit on platforms without one. */
  readonly readSecret?: () => Promise<string | null | undefined>;
}

function normalizeKey(value: unknown): string | undefined {
  // Runtime env maps can carry non-strings despite the declared types
  // (import.meta.env booleans, test doubles) — a bare .trim() would throw.
  if (typeof value !== 'string') {
    return;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export async function resolveHostedProviderKey(
  options: ResolveHostedProviderKeyOptions
): Promise<HostedKeyResolution> {
  for (const source of options.envSources) {
    if (!source) {
      continue;
    }
    for (const name of options.envKeyNames) {
      // Env maps are capability surfaces (import.meta.env proxies, test
      // doubles); a throwing read means "this source is absent", matching
      // every prior resolver's behavior — never a resolution failure.
      let raw: unknown;
      try {
        raw = source[name];
      } catch {
        break;
      }
      const key = normalizeKey(raw);
      if (key) {
        return { key, source: 'env' };
      }
    }
  }

  if (!options.readSecret) {
    return {};
  }
  try {
    const key = normalizeKey(await options.readSecret());
    return key ? { key, source: 'secrets' } : {};
  } catch (error) {
    return { secretReadError: error };
  }
}

/**
 * DOM event dispatched by the secrets settings UI after a key is saved or
 * deleted, so key caches invalidate without a package dependency between the
 * mutation site (data-platform) and the cache owner (indexing) — both may
 * import this shared-foundation constant, neither may import the other.
 */
export const SECRETS_CHANGED_EVENT_NAME = 'brainstrike:secrets-changed';
