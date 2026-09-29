import { isAllowedProviderKeySourceEnvVar } from '@brainstrike/assistant-contract';
import {
  listProviders,
  providerAuthType,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { TAVILY_ENV_KEYS } from '@brainstrike/assistant-contract/tavily-env-keys';
import { TAVILY_SECRET_PROVIDER } from './provider-key-types';

/**
 * Parsing rules for the `secrets.list()` credential-source payload, shared by
 * every strict consumer.
 *
 * WHY THIS MODULE EXISTS: two surfaces now read the same listing — the
 * Credential Inventory table (per-row state) and the Provider Hub page
 * (per-card connection state). Both must accept exactly the same provider ids
 * and env-var names, or one would show a provider as connected while the other
 * called the same payload malformed. Keeping the rules here makes that
 * divergence impossible by construction (BST-1358).
 */

/** Canonical list — never re-spelled here (BST-1363 review). */
const TAVILY_ENV_KEY_SET = new Set<string>(TAVILY_ENV_KEYS);

export function invalidCredentialStatus(): Error {
  return new Error('The desktop returned invalid credential status metadata.');
}

export function isAllowedProviderEnvVar(provider: string, envVar: string): boolean {
  if (provider === TAVILY_SECRET_PROVIDER) {
    return TAVILY_ENV_KEY_SET.has(envVar);
  }
  const supported = provider as SupportedProvider;
  // BST-1353: an aws-authType provider may report a chain ACTIVATION name
  // (AWS_PROFILE / AWS_ACCESS_KEY_ID) as its source. Those are configuration,
  // not credentials, so they are absent from the registry — the shared rule
  // admits them so this parser and the app-shell one cannot drift.
  return isAllowedProviderKeySourceEnvVar(
    envVar,
    providerEnvKeys(supported),
    providerAuthType(supported) === 'aws'
  );
}

/**
 * Every provider id the bridge may legitimately mention. Deliberately the
 * UNFILTERED registry plus Tavily — a listing may name a provider the calling
 * surface does not render (a stored entry for a keyless local runtime), and
 * that is not a malformed payload.
 */
export function allowedProviderKeyIds(): ReadonlySet<string> {
  return new Set<string>([
    ...listProviders().map((definition) => definition.id),
    TAVILY_SECRET_PROVIDER,
  ]);
}
