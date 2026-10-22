/**
 * Named reason shown when the selected set has no embedded chunks yet. This is
 * the ONE honestly-gateable precondition for semantic search from the renderer.
 */
export const SEMANTIC_UNAVAILABLE_NO_CHUNKS =
  'No embedded chunks in this collection yet — indexing may still be running.';

export interface SemanticAvailability {
  /** False when semantic search cannot run for the selected set. */
  available: boolean;
  /** Named reason to surface (tooltip); null when available. */
  reason: string | null;
}
