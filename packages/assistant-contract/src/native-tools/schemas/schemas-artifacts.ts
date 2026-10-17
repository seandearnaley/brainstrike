/** Shared cursor/page grammar for the provider tool and the internal artifact reader. */
import { Schema } from 'effect';
import {
  isToolOutputArtifactCursor,
  TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
  TOOL_OUTPUT_ARTIFACT_MIN_PAGE_BYTES,
} from '../../tool-output-artifact.js';

export const ArtifactPageSizeSchema = Schema.optionalKey(
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(TOOL_OUTPUT_ARTIFACT_MIN_PAGE_BYTES),
    Schema.isLessThanOrEqualTo(TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES)
  )
);

export const ArtifactCursorSchema = Schema.String.annotate({
  description: 'Prior cursor; copy byte-for-byte, never edit or recreate it.',
}).check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(2048),
  Schema.makeFilter((value) =>
    isToolOutputArtifactCursor(value) ? undefined : 'Malformed tool output artifact cursor'
  )
);

export const ArtifactSearchPatternSchema = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(2000)
);

export function requireSearchPatternForFlags(input: {
  readonly caseSensitive?: boolean | undefined;
  readonly isRegex?: boolean | undefined;
  readonly pattern?: string | undefined;
}): Schema.FilterIssue[] {
  if (input.pattern === undefined) {
    return (['caseSensitive', 'isRegex'] as const)
      .filter((field) => input[field] !== undefined)
      .map((field) => ({ issue: `${field} requires pattern.`, path: [field] }));
  }
  if (input.isRegex !== true) {
    return [];
  }
  // Syntax only; execution retains its separate ReDoS-shape safety guard.
  try {
    new RegExp(input.pattern);
    return [];
  } catch {
    return [
      {
        issue: 'pattern is not a valid JavaScript regular expression (isRegex is true)',
        path: ['pattern'],
      },
    ];
  }
}

export const ReadToolOutputArtifactCursorInputSchema = Schema.Struct({
  caseSensitive: Schema.optionalKey(Schema.Boolean),
  cursor: ArtifactCursorSchema,
  isRegex: Schema.optionalKey(Schema.Boolean),
  maxBytes: ArtifactPageSizeSchema,
  pattern: Schema.optionalKey(ArtifactSearchPatternSchema),
}).check(Schema.makeFilter(requireSearchPatternForFlags));

export type ReadToolOutputArtifactCursorInput = typeof ReadToolOutputArtifactCursorInputSchema.Type;
