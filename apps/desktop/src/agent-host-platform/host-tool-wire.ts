/**
 * Wire shapes of the narrow Main reads and window-bound calls the agent host's
 * own tools make (`desktop-read/*`, `platform/worktree/*`, `platform/shell/*`).
 * Shared by Main's handlers and the host's clients; imports nothing Main-only.
 * Optional fields are exact (`exactOptional`), matching the store types under
 * `exactOptionalPropertyTypes`.
 */
import { z } from 'zod';

const Id = z.string().min(1);

export const PlatformShellCompletedSchema = z.strictObject({
  command: z.string(),
  precedingWorktreePaths: z.array(z.string()).nullable(),
  rootId: Id,
  runId: Id.optional(),
  threadId: Id,
});

export const WorktreePathsResultSchema = z.strictObject({
  paths: z.array(z.string()).nullable(),
});

/** `GrepSearchOptions` of the indexed grep half (`@brainstrike/db`). */
export const GrepIndexOptionsSchema = z.strictObject({
  candidateLimit: z.number().int().positive().exactOptional(),
  caseSensitive: z.boolean().exactOptional(),
  contextLines: z.number().int().nonnegative().exactOptional(),
  embeddingSetId: Id.exactOptional(),
  filePaths: z.array(z.string()).exactOptional(),
  isRegex: z.boolean().exactOptional(),
  maxResults: z.number().int().positive().exactOptional(),
  pattern: z.string().min(1),
  rootId: Id.exactOptional(),
  rootIds: z.array(Id).exactOptional(),
});

export const GrepIndexRequestSchema = z.strictObject({
  options: GrepIndexOptionsSchema,
  threadId: Id,
});

/** `GrepSearchResult` of the indexed grep half (`@brainstrike/db`). */
export const GrepIndexResultSchema = z.strictObject({
  candidatesTruncated: z.boolean(),
  matches: z.array(
    z.strictObject({
      after: z.array(z.string()),
      before: z.array(z.string()),
      chunkEndLine: z.number().int().exactOptional(),
      chunkId: z.string().exactOptional(),
      chunkStartLine: z.number().int().exactOptional(),
      line: z.number().int(),
      lineText: z.string(),
      path: z.string(),
      rootId: z.string().nullable().exactOptional(),
      rootName: z.string().nullable().exactOptional(),
    })
  ),
  scanLimited: z.boolean(),
  skippedMissingLineMetadata: z.number().int().nonnegative(),
  totalMatches: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
