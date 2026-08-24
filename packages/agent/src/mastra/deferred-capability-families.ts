/**
 * The single source for how DEFERRED tool capabilities are named to the model.
 *
 * Two model-facing surfaces name what `search_tools` can load: the discovery
 * line in the composed instructions and the `search_tools` tool description
 * itself. Both previously carried independent hand-written lists, and both
 * drifted — the 2026-08-23 field failure dismissed "the canvas tool"
 * (`manageCanvas`) and a skill activation's named `runSkillScript` as
 * nonexistent because neither list mentioned them. Review of #2625 then found
 * the replacement list was UNCONDITIONAL: a web run (whose eligible set
 * excludes canvas, Python, browsers, command sessions, diagnostics, self-query
 * and skill scripts — see `WEB_NATIVE_TOOL_IDS`) would advertise capabilities
 * that can never load.
 *
 * This module owns the mapping once: family phrases keyed to the ORIGINAL tool
 * ids that make them real, filtered per run against the tools actually
 * eligible. The `tool-discovery capability coverage` spec pins the other
 * direction — every runtime-deferred native tool id must belong to a family —
 * so a new deferred tool cannot ship without a name here.
 */

import {
  NATIVE_TOOL_ID,
  WEB_EXTRACT_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
} from '@brainstrike/assistant-contract';

export interface DeferredCapabilityFamily {
  /** Original (pre-sanitization) tool ids; ANY present makes the family real. */
  readonly ids: readonly string[];
  /** The short model-facing capability phrase. */
  readonly phrase: string;
}

export const DEFERRED_CAPABILITY_FAMILIES: readonly DeferredCapabilityFamily[] = [
  { ids: [NATIVE_TOOL_ID.manageCanvas], phrase: 'canvas documents' },
  { ids: [NATIVE_TOOL_ID.manageTaskList], phrase: 'task lists' },
  { ids: [NATIVE_TOOL_ID.runSkillScript], phrase: 'skill scripts' },
  { ids: [NATIVE_TOOL_ID.runPython], phrase: 'Python' },
  {
    ids: [
      NATIVE_TOOL_ID.browserGetPageText,
      NATIVE_TOOL_ID.browserNavigate,
      NATIVE_TOOL_ID.browserReadPage,
    ],
    phrase: 'browser pages',
  },
  { ids: [WEB_EXTRACT_TOOL_ID, WEB_SEARCH_TOOL_ID], phrase: 'web search/extract' },
  {
    ids: [NATIVE_TOOL_ID.inspectCommandSessions, NATIVE_TOOL_ID.manageCommandSession],
    phrase: 'command sessions',
  },
  {
    ids: [NATIVE_TOOL_ID.deleteWorkspaceFile, NATIVE_TOOL_ID.renameWorkspaceFile],
    phrase: 'file delete/rename',
  },
  { ids: [NATIVE_TOOL_ID.readWorkspaceDirectory], phrase: 'directory listings' },
  {
    ids: [
      NATIVE_TOOL_ID.listWorkspaceContext,
      NATIVE_TOOL_ID.readWorkspaceContext,
      NATIVE_TOOL_ID.updateWorkspaceContextSelection,
      NATIVE_TOOL_ID.updateWorkspaceTapestrySelections,
    ],
    phrase: 'workspace context and tapestry',
  },
  {
    ids: [NATIVE_TOOL_ID.findWorkspaceSymbol, NATIVE_TOOL_ID.lspInspect],
    phrase: 'symbol and LSP inspection',
  },
  {
    ids: [
      NATIVE_TOOL_ID.hybridSearch,
      NATIVE_TOOL_ID.listEmbeddingSpaces,
      NATIVE_TOOL_ID.queryEmbeddingSpace,
    ],
    phrase: 'embedding search',
  },
  { ids: [NATIVE_TOOL_ID.queryDiagnostics], phrase: 'diagnostics' },
  { ids: [NATIVE_TOOL_ID.querySelf], phrase: 'DB self-query' },
  { ids: [NATIVE_TOOL_ID.readToolOutputArtifact], phrase: 'tool-output artifacts' },
];

/**
 * The comma-joined phrases of the families this run can actually load, or ''
 * when none apply. Callers must never advertise a family whose tools are not
 * eligible — that is the confusion this module exists to prevent.
 */
export function describeAvailableDeferredCapabilityFamilies(
  availableOriginalToolIds: ReadonlySet<string>
): string {
  return DEFERRED_CAPABILITY_FAMILIES.filter((family) =>
    family.ids.some((id) => availableOriginalToolIds.has(id))
  )
    .map((family) => family.phrase)
    .join(', ');
}
