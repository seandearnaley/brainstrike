import {
  isSupportedProvider,
  providerDeprecatedEnvKeys,
  providerEnvKeys,
} from '@brainstrike/assistant-contract/provider-metadata';
import { TAVILY_ENV_KEYS } from '@brainstrike/assistant-contract/tavily-env-keys';
import { type CredentialSlot, listCredentialSlots } from '../credential-inventory/credential-slots';
import { TAVILY_SECRET_PROVIDER } from '../provider-key-types';

/**
 * Every environment name that configures a given slot. Built from the SLOT
 * list rather than the raw registry so a chip can only ever target a row that
 * actually exists — a keyless local runtime has no inventory row, and a chip
 * pointing at one would scroll to nothing.
 *
 * Names are enumerated as complete sets (`providerEnvKeys` plus the retired
 * names), never by positional index: which entry is the override and which is
 * the vendor name is the registry's business, not this module's.
 */
function slotEnvVariableNames(slot: CredentialSlot): readonly string[] {
  if (slot.id === TAVILY_SECRET_PROVIDER) {
    return TAVILY_ENV_KEYS;
  }
  if (!isSupportedProvider(slot.id)) {
    // Slots are Tavily plus registry providers. A third kind means the slot
    // list grew a source this index does not know how to name — surface it
    // rather than silently indexing nothing for it.
    throw new Error(`Credential slot "${slot.id}" has no known environment variable names.`);
  }
  return [...providerEnvKeys(slot.id), ...providerDeprecatedEnvKeys(slot.id)];
}

/**
 * Maps an environment variable NAME to the Credential Inventory slot it
 * configures, so a chip can jump to the row it belongs to.
 *
 * Retired names map to their slot too: a user who still has the old name set
 * wants to find the row it affects.
 */
export function buildEnvVariableSlotIndex(): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const slot of listCredentialSlots()) {
    for (const name of slotEnvVariableNames(slot)) {
      index.set(name, slot.id);
    }
  }
  return index;
}

/**
 * Every RETIRED provider env name, across all slots.
 *
 * The Environment section needs this to decide what may render as a live
 * chip. Membership here — not "did the loader see it in a file" — is the test:
 * a retired name exported from the user's shell is just as dead as one
 * spelled in `.env`, and presenting it as a working variable would be a lie.
 */
export function buildDeprecatedEnvVariableNameSet(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const slot of listCredentialSlots()) {
    // Tavily declares no retired names (it is outside the registry entirely).
    if (!isSupportedProvider(slot.id)) {
      continue;
    }
    for (const name of providerDeprecatedEnvKeys(slot.id)) {
      names.add(name);
    }
  }
  return names;
}
