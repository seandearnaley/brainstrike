import type { SkippedSourceRangeChunk } from './tools/retrieval-tool';

const MAX_AFFECTED_FILES = 3;

export interface RetrievalCoverageNoteInput {
  /** File paths or names keyed by file record id for concise listing */
  affectedFilePaths?: ReadonlyMap<string, string>;
  skippedForMissingSourceRange: number;
  skippedForTokenBudget?: number;
  skippedSourceRangeChunks?: readonly SkippedSourceRangeChunk[];
}

function uniqueAffectedFileIds(chunks: readonly SkippedSourceRangeChunk[] | undefined): string[] {
  if (!chunks || chunks.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const chunk of chunks) {
    if (!seen.has(chunk.fileRecordId)) {
      seen.add(chunk.fileRecordId);
      ordered.push(chunk.fileRecordId);
    }
  }
  return ordered;
}

function formatAffectedFiles(
  fileIds: readonly string[],
  affectedFilePaths?: ReadonlyMap<string, string>
): string | undefined {
  if (fileIds.length === 0) {
    return;
  }
  const labels = fileIds.slice(0, MAX_AFFECTED_FILES).map((id) => affectedFilePaths?.get(id) ?? id);
  const remainder = fileIds.length - labels.length;
  if (remainder > 0) {
    return `${labels.join(', ')} (+${remainder} more)`;
  }
  return labels.join(', ');
}

/**
 * Concise, token-aware coverage note for retrieval tool context strings.
 * Returns an empty string when there is nothing to report.
 */
export function formatRetrievalCoverageNote(input: RetrievalCoverageNoteInput): string {
  const missingRange = input.skippedForMissingSourceRange;
  const tokenBudget = input.skippedForTokenBudget ?? 0;
  if (missingRange <= 0 && tokenBudget <= 0) {
    return '';
  }

  const parts: string[] = [];
  if (missingRange > 0) {
    parts.push(`${missingRange} chunk${missingRange === 1 ? '' : 's'} missing source line ranges`);
  }
  if (tokenBudget > 0) {
    parts.push(`${tokenBudget} chunk${tokenBudget === 1 ? '' : 's'} omitted for token budget`);
  }

  const skippedSummary = parts.join('; ');
  const reindexHint =
    missingRange > 0 ? ' Re-index the embedding space for line-aware retrieval and citations.' : '';
  const affectedFiles = formatAffectedFiles(
    uniqueAffectedFileIds(input.skippedSourceRangeChunks),
    input.affectedFilePaths
  );
  const filesSuffix = affectedFiles ? ` Affected files: ${affectedFiles}.` : '';

  return `[Retrieval coverage] Skipped ${skippedSummary}.${reindexHint}${filesSuffix}`.trim();
}
