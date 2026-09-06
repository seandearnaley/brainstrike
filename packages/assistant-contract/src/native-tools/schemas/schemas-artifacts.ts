/**
 * Input schema for `brainstrike.readToolOutputArtifact` (cursor continuation).
 *
 * Extracted from the agent's artifact reader in BST-1646 so the native-tool
 * input catalog is browser-safe end to end. The reader still owns the
 * artifact-mode schema (`ReadToolOutputArtifactInputSchema`) and the paging
 * runtime; it imports the shared field schemas from here.
 */
import { z } from 'zod';
import {
  isToolOutputArtifactCursor,
  TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
  TOOL_OUTPUT_ARTIFACT_MIN_PAGE_BYTES,
} from '../../tool-output-artifact.js';

export const ArtifactPageSizeSchema = z
  .number()
  .int()
  .min(TOOL_OUTPUT_ARTIFACT_MIN_PAGE_BYTES)
  .max(TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES)
  .optional();

export const ArtifactCursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isToolOutputArtifactCursor, 'Malformed tool output artifact cursor')
  .describe('Prior cursor; copy byte-for-byte, never edit or recreate it.');

export const ArtifactSearchPatternSchema = z.string().min(1).max(2000);

export function requireSearchPatternForFlags(
  input: {
    readonly caseSensitive?: boolean | undefined;
    readonly isRegex?: boolean | undefined;
    readonly pattern?: string | undefined;
  },
  context: z.RefinementCtx
): void {
  if (input.pattern === undefined) {
    for (const field of ['caseSensitive', 'isRegex'] as const) {
      if (input[field] !== undefined) {
        context.addIssue({
          code: 'custom',
          message: `${field} requires pattern.`,
          path: [field],
        });
      }
    }
    return;
  }
  if (input.isRegex !== true) {
    return;
  }
  // Fail-fast: mirrors GrepSearchInputSchema's regex refine
  // (schemas-search.ts) — reject an invalid pattern at parse rather than
  // deferring the failure to execution (no silent fallback). ReDoS-shape
  // safety is a separate, execution-time check (assertSafeRegexSource in
  // createSearchMatcher, matching the shared guard grepSearch's own matcher
  // uses) since it is about the pattern's SHAPE, not its syntax.
  try {
    new RegExp(input.pattern);
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'pattern is not a valid JavaScript regular expression (isRegex is true)',
      path: ['pattern'],
    });
  }
}

export const ReadToolOutputArtifactCursorInputSchema = z
  .object({
    caseSensitive: z.boolean().optional(),
    cursor: ArtifactCursorSchema,
    isRegex: z.boolean().optional(),
    maxBytes: ArtifactPageSizeSchema,
    pattern: ArtifactSearchPatternSchema.optional(),
  })
  .strict()
  .superRefine(requireSearchPatternForFlags);

export type ReadToolOutputArtifactCursorInput = z.infer<
  typeof ReadToolOutputArtifactCursorInputSchema
>;
