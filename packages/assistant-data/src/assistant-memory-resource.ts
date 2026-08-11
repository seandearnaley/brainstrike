/**
 * Stable, workspace-global resource id for assistant memory (Mastra threads,
 * messages, run events, observational memory).
 *
 * Assistant conversations belong to the WORKSPACE, not to any single focused
 * root. Keying them on the focused root's filesystem path made them vanish
 * whenever focus changed (e.g. adding a folder re-focused the new root), and
 * gated the assistant behind "open a folder first" when no root was active.
 * This constant decouples the assistant from roots entirely: it exists with
 * zero roots and never changes as roots are added, removed, or refocused.
 */
export const WORKSPACE_MEMORY_RESOURCE_ID = 'brainstrike:workspace';

/**
 * Resolve the assistant memory resource id. An explicit, non-empty override
 * wins (used by tests and any future per-workspace scoping); otherwise every
 * caller resolves to the single workspace-global id.
 */
export function resolveAssistantMemoryResourceId(override?: string | null): string {
  return override && override.length > 0 ? override : WORKSPACE_MEMORY_RESOURCE_ID;
}
