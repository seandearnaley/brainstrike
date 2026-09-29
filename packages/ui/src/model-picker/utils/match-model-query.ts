/** The text a model can be found by. */
export interface ModelQueryFields {
  /**
   * Extra searchable tags that are never displayed by the matcher (BST-1805:
   * the Model Catalog passes a row's best-for tags so they stay searchable).
   */
  keywords?: readonly string[] | undefined;
  label: string;
  modelId: string;
  providerId: string;
  providerName?: string | null | undefined;
  tagline?: string | null | undefined;
}

// Newline separates fields so a query word (which never contains whitespace)
// cannot match across two of them.
const FIELD_SEPARATOR = '\n';

/**
 * Case-insensitive, whitespace-tokenised AND: every word must appear in one of
 * the fields. An empty or whitespace-only query matches everything. No fuzzy
 * matching — the same rule the command palette documents.
 */
export function matchesModelQuery(fields: ModelQueryFields, query: string): boolean {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return true;
  }
  const haystack = [
    fields.label,
    fields.modelId,
    fields.providerId,
    fields.providerName ?? '',
    fields.tagline ?? '',
    ...(fields.keywords ?? []),
  ]
    .join(FIELD_SEPARATOR)
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}
