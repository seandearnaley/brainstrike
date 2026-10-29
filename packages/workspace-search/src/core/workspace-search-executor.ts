export interface TextSearchRequest {
  caseSensitive: boolean;
  embeddingSetId: string;
  isRegex: boolean;
  maxResults?: number;
  query: string;
  rootIds: readonly string[];
  wholeWord: boolean;
}

/** Escape JS regex metacharacters so a literal string can be embedded in a pattern. */
export function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Derive the grep pattern + isRegex flag from a text-search request.
 * - literal + wholeWord: escape the literal, then wrap in `\b…\b` (now a regex).
 * - regex + wholeWord: wrap the regex source in `\b(?:…)\b` (no escaping).
 * - otherwise: pass the query/isRegex through unchanged.
 */
export function buildGrepPattern(req: Pick<TextSearchRequest, 'query' | 'isRegex' | 'wholeWord'>): {
  pattern: string;
  isRegex: boolean;
} {
  if (req.wholeWord) {
    const source = req.isRegex ? req.query : escapeRegExpLiteral(req.query);
    const wrapped = req.isRegex ? `\\b(?:${source})\\b` : `\\b${source}\\b`;
    return { isRegex: true, pattern: wrapped };
  }
  return { isRegex: req.isRegex, pattern: req.query };
}
