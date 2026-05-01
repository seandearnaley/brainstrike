/**
 * Sentinel prefix that file-content loaders write into the content map when a file
 * handle exists but the bytes can't be read (permission missing, folder mismatch,
 * etc.). Consumers detect this state by `content.startsWith(INACCESSIBLE_CONTENT_PREFIX)`
 * — a brittle pattern that we keep tightly coupled by sharing this constant rather
 * than letting the producers and consumers each hardcode the string.
 *
 * TODO(BST-XXX): graduate this from a content-prefix sentinel to a structured status
 * (e.g. an `inaccessible` entry on the tabStatuses map) so producers and consumers
 * exchange a typed contract instead of an English-prose prefix. Until then,
 * importing this constant from a single source guarantees the producers and
 * consumers can't drift independently.
 */
export const INACCESSIBLE_CONTENT_PREFIX = 'File not accessible' as const;

/**
 * Compose a full inaccessible-content message with a producer-supplied reason.
 * Always starts with INACCESSIBLE_CONTENT_PREFIX so consumer guards match.
 */
export function buildInaccessibleContent(reason: string): string {
  return `${INACCESSIBLE_CONTENT_PREFIX} - ${reason}`;
}
