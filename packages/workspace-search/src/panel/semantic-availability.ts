/**
 * Named reason shown when the index has no embedded chunks yet. This is the ONE
 * honestly-gateable precondition for semantic search from the renderer.
 */
export const SEMANTIC_UNAVAILABLE_NO_CHUNKS =
  'No embedded chunks in the index yet — indexing may still be running.';

export interface SemanticAvailability {
  /** False when semantic search cannot run for the searched roots. */
  available: boolean;
  /** Named reason to surface (tooltip); null when available. */
  reason: string | null;
}
