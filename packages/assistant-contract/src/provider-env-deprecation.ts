// Imports ONLY provider-registry (review 10f): provider-metadata re-exports
// this module, so an import edge back into provider-metadata would be a
// source cycle.
import {
  getProviderDeprecatedEnvKeys,
  getProviderVendorEnvKey,
  listProviders,
  type ProviderId,
} from './provider-registry.js';

/**
 * A deprecated provider env var found SET in a process environment
 * (BST-1361). `replacement` is the provider's vendor-standard canonical name
 * ({@link getProviderVendorEnvKey}), matching the spec'd rename guidance (e.g.
 * `OPENAI_API_KEY_V2` -> `OPENAI_API_KEY`), never the `BRAINSTRIKE_*`
 * override.
 */
export interface DeprecatedEnvVarReport {
  readonly envVar: string;
  readonly provider: ProviderId;
  readonly replacement: string;
}

/**
 * Scan an environment map for deprecated provider env names (BST-1361).
 *
 * Hosts compute this from their OWN process env — never from the wire. A
 * name counts as set when its value contains any non-whitespace character;
 * unset, empty, and whitespace-only values are silent (they cannot have
 * authenticated under the old scheme either). Results follow registry
 * declaration order, then each provider's `deprecatedEnvKeys` order.
 */
export function detectDeprecatedProviderEnvVars(
  env: Readonly<Record<string, string | undefined>>
): readonly DeprecatedEnvVarReport[] {
  // Windows environment names are case-insensitive. Apply the same rule on
  // every platform — mirroring createCredentialIsolatedChildEnvironment — so
  // a mixed-case source object cannot dodge the rename warning while still
  // colliding with the credential scrubber. Reports always carry the
  // canonical (uppercase) registry spelling.
  const setNames = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      setNames.add(name.toUpperCase());
    }
  }

  const reports: DeprecatedEnvVarReport[] = [];
  for (const provider of listProviders()) {
    const deprecatedNames = getProviderDeprecatedEnvKeys(provider.id);
    if (deprecatedNames.length === 0) {
      continue;
    }
    const replacement = getProviderVendorEnvKey(provider.id);
    if (!replacement) {
      // A provider with deprecated names but no canonical names is a registry
      // authoring error; surface it instead of inventing a replacement.
      throw new Error(
        `Provider ${provider.id} declares deprecatedEnvKeys without canonical envKeys`
      );
    }
    for (const envVar of deprecatedNames) {
      if (setNames.has(envVar)) {
        reports.push({ envVar, provider: provider.id, replacement });
      }
    }
  }
  return reports;
}
