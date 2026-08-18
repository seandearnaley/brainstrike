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

import type { ProviderCredential } from './provider-credential.js';

export interface HostedKeyResolution {
  readonly key?: string;
  /**
   * A secret-store read failure captured while no key was found anywhere.
   * Never set when `key` is present.
   */
  readonly secretReadError?: unknown;
  /** Where the winning key came from; absent when no key was found. */
  readonly source?: 'env' | 'stored';
}

export interface ResolveHostedProviderKeyOptions {
  /** Env var names for this provider, checked in order within each source. */
  readonly envKeyNames: readonly string[];
  /** Environment maps, checked in order (e.g. process.env, import.meta.env). */
  readonly envSources: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>;
  /** Platform secret store read; omit on platforms without one. */
  readonly readSecret?: () => Promise<string | null | undefined>;
}

/**
 * Typed generalization of {@link HostedKeyResolution} (BST-1352): the winning
 * value is a full `ProviderCredential`, not only a bearer-key string. Same
 * contract in every other respect — env-authoritative order, never throws,
 * `secretReadError` only when nothing was found.
 */
export interface HostedCredentialResolution {
  readonly credential?: ProviderCredential;
  /**
   * A credential-store read failure captured while no credential was found
   * anywhere. Never set when `credential` is present.
   */
  readonly secretReadError?: unknown;
  /** Where the winning credential came from; absent when nothing was found. */
  readonly source?: 'env' | 'stored';
}

export interface ResolveHostedProviderCredentialOptions {
  /** Env var names for this provider, checked in order within each source. */
  readonly envKeyNames: readonly string[];
  /** Environment maps, checked in order (e.g. process.env, import.meta.env). */
  readonly envSources: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>;
  /** Platform typed-credential store read; omit on platforms without one. */
  readonly readCredential?: () => Promise<ProviderCredential | null | undefined>;
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

/**
 * The BST-1352 credential core `resolveHostedProviderKey` now rides on.
 * Environment variables can only ever express a bearer key, so an env hit is
 * BY DEFINITION `{ type: 'api_key', key }`; typed credentials (`oauth`, `aws`)
 * exist only in the platform store. The documented BST-979 contract is
 * preserved exactly: env-authoritative caller order, this function never
 * throws, and `secretReadError` passes through only when no credential was
 * found anywhere.
 */
export async function resolveHostedProviderCredential(
  options: ResolveHostedProviderCredentialOptions
): Promise<HostedCredentialResolution> {
  for (const source of options.envSources) {
    if (!source) {
      continue;
    }
    for (const name of options.envKeyNames) {
      // NO SILENT FALLBACK: a throwing read on an obtained env map surfaces
      // to the caller rather than silently authenticating with a
      // lower-priority credential. Capability handling (a source that cannot
      // be OBTAINED at all) belongs to the caller's source acquisition, not
      // here.
      const key = normalizeKey(source[name]);
      if (key) {
        return { credential: { key, type: 'api_key' }, source: 'env' };
      }
    }
  }

  if (!options.readCredential) {
    return {};
  }
  try {
    const credential = await options.readCredential();
    return credential ? { credential, source: 'stored' } : {};
  } catch (error) {
    return { secretReadError: error };
  }
}

/**
 * Present a legacy string `readSecret` as a typed credential read. A blank
 * stored string was never a configured key here — the pre-BST-1352
 * implementation normalized before deciding, so the legacy mapping happens on
 * the normalized value only. (Named helper rather than an inline annotated
 * async arrow: Babel's TS parser rejects the annotation in that position.)
 */
function legacyReadCredential(
  readSecret: NonNullable<ResolveHostedProviderKeyOptions['readSecret']>
): NonNullable<ResolveHostedProviderCredentialOptions['readCredential']> {
  return async () => {
    const key = normalizeKey(await readSecret());
    return key ? { key, type: 'api_key' } : null;
  };
}

export async function resolveHostedProviderKey(
  options: ResolveHostedProviderKeyOptions
): Promise<HostedKeyResolution> {
  const { readSecret } = options;
  const resolution = await resolveHostedProviderCredential({
    envKeyNames: options.envKeyNames,
    envSources: options.envSources,
    ...(readSecret ? { readCredential: legacyReadCredential(readSecret) } : {}),
  });
  // The string resolver only ever produces api_key credentials (env values
  // and normalized stored strings), so the narrow is total in practice; the
  // guard exists purely so TypeScript sees the discriminant.
  if (resolution.credential?.type === 'api_key') {
    return {
      key: resolution.credential.key,
      // `source` is always set alongside `credential`; the spread only
      // satisfies exactOptionalPropertyTypes.
      ...(resolution.source ? { source: resolution.source } : {}),
    };
  }
  return 'secretReadError' in resolution ? { secretReadError: resolution.secretReadError } : {};
}

/**
 * DOM event dispatched by the secrets settings UI after a key is saved or
 * deleted, so key caches invalidate without a package dependency between the
 * mutation site (data-platform) and the cache owner (indexing) — both may
 * import this shared-foundation constant, neither may import the other.
 */
export const SECRETS_CHANGED_EVENT_NAME = 'brainstrike:secrets-changed';
