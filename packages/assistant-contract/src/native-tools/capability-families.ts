import type { DeferredCapabilityFamilyPhrase } from './define.js';

/**
 * The single source for how DEFERRED tool capabilities are named to the model,
 * in EMISSION ORDER.
 *
 * Two model-facing surfaces name what `search_tools` can load: the discovery
 * line in the composed instructions and the `search_tools` tool description
 * itself. Both previously carried independent hand-written lists, and both
 * drifted — the 2026-08-23 field failure dismissed "the canvas tool"
 * (`manageCanvas`) and a skill activation's named `runSkillScript` as
 * nonexistent because neither list mentioned them. Review of #2625 then found
 * the replacement list was UNCONDITIONAL: a web run (whose eligible set
 * excludes canvas, Python, browsers, command sessions, diagnostics and skill
 * scripts — see `WEB_NATIVE_TOOL_IDS`) would advertise capabilities
 * that can never load.
 *
 * Membership is no longer listed here: each tool definition names its family
 * (`discovery.family`), and `deriveNativeToolRegistries` groups the catalog by
 * this order. A phrase with no tool, or a deferred tool with no family, fails
 * at derivation time — never in the field as a "tool does not exist"
 * hallucination.
 */
export const DEFERRED_CAPABILITY_FAMILY_PHRASES = [
  'canvas documents',
  'task lists',
  'skill scripts',
  'Python',
  'browser pages',
  'web search/extract',
  'command sessions',
  'git worktrees',
  'file delete/rename',
  'directory listings',
  'workspace context',
  'symbol and LSP inspection',
  'embedding search',
  'diagnostics',
  'tool-output artifacts',
] as const satisfies readonly DeferredCapabilityFamilyPhrase[];

/**
 * The comma-joined phrases of the families this run can actually load, or ''
 * when none apply. Callers must never advertise a family whose tools are not
 * eligible — that is the confusion this module exists to prevent.
 */
export function describeAvailableDeferredCapabilityFamilies(
  families: readonly DeferredCapabilityFamily[],
  availableOriginalToolIds: ReadonlySet<string>
): string {
  return families
    .filter((family) => family.ids.some((id) => availableOriginalToolIds.has(id)))
    .map((family) => family.phrase)
    .join(', ');
}

export interface DeferredCapabilityFamily {
  /** Original (pre-sanitization) tool ids; ANY present makes the family real. */
  readonly ids: readonly string[];
  /** The short model-facing capability phrase. */
  readonly phrase: DeferredCapabilityFamilyPhrase;
}
