// Preconversion Zod oracle, test-only.
/**
 * What a content-bearing tool call delivered to the model (ADR-0021).
 *
 * The thread context map folds committed raw tool results with these
 * browser-safe schemas. Each schema names only the fields that say which
 * lines reached the model; extra fields pass through. A result that does not
 * match its tool's schema is shown as unmapped, never guessed.
 *
 * Some projections send the model less than the raw result holds (a grep page
 * cut to the character budget, a hybrid list cut to the items that fit). Each
 * cut is recorded in the delivered text by a formatter defined here, and the
 * fold reads it back with the matching parser, so the producer and the reader
 * share one owner of the format.
 */
import { z } from 'zod';

// --- Projection formats: the producer writes them, the fold reads them back ---

/** `1-50/61`, `1-50/61+` (a lower bound), or `empty@offset=50/61` for a page with nothing kept. */
export function formatGrepProjectionPageRange(args: {
  readonly kept: number;
  readonly lowerBound: boolean;
  readonly offset: number;
  readonly total: number;
}): string {
  const totalLabel = `${args.total}${args.lowerBound ? '+' : ''}`;
  if (args.kept === 0) {
    return `empty@offset=${args.offset}/${totalLabel}`;
  }
  return `${args.offset + 1}-${args.offset + args.kept}/${totalLabel}`;
}

const GREP_CONTENT_HEADER = /^grep content (?:(\d+)-(\d+)|empty@offset=(\d+))\/\d+\+?(?:\s|$)/u;

/**
 * The page a delivered grep content projection kept, from its first line, or
 * undefined when the text is not a grep content projection.
 */
export function parseGrepContentProjectionPage(
  text: string
): { readonly kept: number; readonly offset: number } | undefined {
  const match = GREP_CONTENT_HEADER.exec(text);
  if (!match) {
    return;
  }
  if (match[3] !== undefined) {
    return { kept: 0, offset: Number(match[3]) };
  }
  const first = Number(match[1]);
  const last = Number(match[2]);
  return { kept: last - first + 1, offset: first - 1 };
}

/** The `shown=` field of a list projection that keeps the first `kept` of `total` items. */
export function formatProjectionShownCount(kept: number, total: number): string {
  return `shown=${kept}/${total}`;
}

/** The kept count from a delivered list projection's `shown=` field, or undefined. */
export function parseProjectionShownCount(text: string): number | undefined {
  const match = /(?:^|\s)shown=(\d+)\/\d+(?:\s|$)/u.exec(text.split('\n', 1)[0] ?? '');
  return match ? Number(match[1]) : undefined;
}

/** The marker a projection writes when it cut packed context text to fit. */
export const PROJECTION_OMITTED_CONTEXT_CHARS = 'projection_omitted_context_chars';

// --- Raw result fields, per tool -------------------------------------------

const Line = z.number().int().positive();
const Count = z.number().int().nonnegative();
const Text = z.string().min(1);

/** readWorkspaceFile: the page it returned is exactly what the model received. */
export const ReadDeliverySchema = z.looseObject({
  approxOutputTokens: Count,
  content: z.string(),
  dedup: z.boolean().optional(),
  endLine: Count,
  path: Text,
  rootId: Text,
  startLine: Line,
  totalLines: Count,
  truncated: z.boolean(),
});
export type ReadDelivery = z.infer<typeof ReadDeliverySchema>;

const GrepMatchDeliverySchema = z.looseObject({
  after: z.array(z.string()),
  before: z.array(z.string()),
  line: Line,
  lineText: z.string(),
  path: Text,
  rootId: Text.nullish(),
  rootName: z.string().nullish(),
});

/** grepSearch content mode: matches from `offset`; the projection may keep fewer. */
export const GrepContentDeliverySchema = z.looseObject({
  matches: z.array(GrepMatchDeliverySchema),
  offset: Count,
  outputMode: z.literal('content'),
});
export type GrepContentDelivery = z.infer<typeof GrepContentDeliverySchema>;

/** grepSearch files mode: paths only, no file content. */
export const GrepFilesDeliverySchema = z.looseObject({ outputMode: z.literal('files') });

/** queryEmbeddingSpace: packed chunks, whose text the projection may cut. */
export const SemanticDeliverySchema = z.looseObject({
  chunkContentIncludedInContext: z.boolean(),
  chunks: z.array(
    z.looseObject({
      filePath: Text.optional(),
      id: Text,
      lineRange: z.looseObject({ end: Line, start: Line }).optional(),
      metadata: z
        .looseObject({ rootId: Text.optional(), rootName: z.string().optional() })
        .optional(),
    })
  ),
});
export type SemanticDelivery = z.infer<typeof SemanticDeliverySchema>;

/** hybridSearch: ranked chunks, each sent as a clipped excerpt; the projection may keep fewer. */
export const HybridDeliverySchema = z.looseObject({
  results: z.array(
    z.looseObject({
      filePath: Text.optional(),
      id: Text,
      rootName: z.string().optional(),
    })
  ),
});
export type HybridDelivery = z.infer<typeof HybridDeliverySchema>;

/** stringReplaceWorkspaceFile: the written range (absent on results recorded before it existed). */
export const StringReplaceDeliverySchema = z.looseObject({
  editedLines: z.looseObject({ endLine: Line, startLine: Line }).optional(),
  path: Text,
  rootId: Text,
});
export type StringReplaceDelivery = z.infer<typeof StringReplaceDeliverySchema>;

/** writeWorkspaceFile: the whole file was written. */
export const WriteDeliverySchema = z.looseObject({ path: Text, rootId: Text });
export type WriteDelivery = z.infer<typeof WriteDeliverySchema>;
