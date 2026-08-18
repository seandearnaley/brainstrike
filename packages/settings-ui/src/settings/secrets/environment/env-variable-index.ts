import {
  listProviders,
  providerDeprecatedEnvKeys,
  providerEnvKeys,
} from '@brainstrike/assistant-contract/provider-metadata';
import { TAVILY_VENDOR_ENV_KEY } from '../credential-inventory/credential-slots';
import { TAVILY_SECRET_PROVIDER } from '../provider-key-types';

/** Tavily's names live outside the provider registry (a search service, not a model provider). */
const TAVILY_ENV_KEYS: readonly string[] = ['BRAINSTRIKE_TAVILY_API_KEY', TAVILY_VENDOR_ENV_KEY];

/**
 * Maps an environment variable NAME to the Credential Inventory slot it
 * configures, so a chip can jump to the row it belongs to. Derived from the
 * shared registry rather than hand-listed — a hand-written map silently
 * drifts from the registry the way a hand-copied allow-list would.
 *
 * Deprecated names map to their slot too: a user who has the retired name set
 * still wants to find the row it affects.
 */
export function buildEnvVariableSlotIndex(): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const definition of listProviders()) {
    for (const name of [
      ...providerEnvKeys(definition.id),
      ...providerDeprecatedEnvKeys(definition.id),
    ]) {
      index.set(name, definition.id);
    }
  }
  for (const name of TAVILY_ENV_KEYS) {
    index.set(name, TAVILY_SECRET_PROVIDER);
  }
  return index;
}

/**
 * Maps a retired variable NAME to the canonical name that replaces it. The
 * replacement is the provider's FIRST resolution name — the app-scoped
 * `BRAINSTRIKE_*` override, which is what the precedence chain reads first.
 */
export function buildDeprecatedEnvVariableRenameIndex(): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const definition of listProviders()) {
    const replacement = providerEnvKeys(definition.id)[0];
    if (replacement === undefined) {
      continue;
    }
    for (const deprecated of providerDeprecatedEnvKeys(definition.id)) {
      index.set(deprecated, replacement);
    }
  }
  return index;
}
