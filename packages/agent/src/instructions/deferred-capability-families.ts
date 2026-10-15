/**
 * The single source for how DEFERRED tool capabilities are named to the model
 * now lives beside the tool definitions (BST-1646): each definition declares
 * its `discovery.family`, and `@brainstrike/assistant-contract` derives the
 * ordered family list. Both model-facing surfaces (the discovery line in the
 * composed instructions and the `search_tools` tool description) read that
 * one list through this module, filtered per run against the tools actually
 * eligible; the `tool-discovery capability coverage` spec pins that every
 * runtime-deferred native tool id belongs to a family.
 */

import {
  DEFERRED_CAPABILITY_FAMILY_PHRASES,
  type DeferredCapabilityFamily,
  describeAvailableDeferredCapabilityFamilies as describeFamilies,
  NATIVE_TOOL_REGISTRIES,
} from '@brainstrike/assistant-contract';

export type { DeferredCapabilityFamily };
export { DEFERRED_CAPABILITY_FAMILY_PHRASES };

export const DEFERRED_CAPABILITY_FAMILIES: readonly DeferredCapabilityFamily[] =
  NATIVE_TOOL_REGISTRIES.capabilityFamilies;

/**
 * The comma-joined phrases of the families this run can actually load, or ''
 * when none apply. Callers must never advertise a family whose tools are not
 * eligible — that is the confusion this module exists to prevent.
 */
export function describeAvailableDeferredCapabilityFamilies(
  availableOriginalToolIds: ReadonlySet<string>
): string {
  return describeFamilies(DEFERRED_CAPABILITY_FAMILIES, availableOriginalToolIds);
}
