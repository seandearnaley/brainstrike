/**
 * UI content-map sentinel used after a typed file-read result reports
 * `status: 'inaccessible'`, or when a browser permission check fails before a
 * worker read begins. Content-map consumers detect this presentation state with
 * `content.startsWith(INACCESSIBLE_CONTENT_PREFIX)`.
 *
 * Worker/loader producers already exchange the structured `FileContentReadResult`;
 * do not regress that boundary to prose classification. The shared prefix remains
 * only at the UI store/rendering boundary until tab state can represent
 * inaccessible content separately from text.
 */
export const INACCESSIBLE_CONTENT_PREFIX = 'File not accessible' as const;

/**
 * Compose the UI content-map representation from a structured or permission
 * failure reason. Always starts with INACCESSIBLE_CONTENT_PREFIX so content-map
 * consumers match the presentation state.
 */
export function buildInaccessibleContent(reason: string): string {
  return `${INACCESSIBLE_CONTENT_PREFIX} - ${reason}`;
}
