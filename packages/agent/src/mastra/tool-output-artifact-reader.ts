import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import {
  decodeToolOutputArtifactContent,
  decodeToolOutputArtifactCursor,
  encodeToolOutputArtifactContent,
  encodeToolOutputArtifactCursor,
  isToolOutputArtifactCursor,
  isToolOutputArtifactPage,
  isToolOutputArtifactReference,
  TOOL_OUTPUT_ARTIFACT_DEFAULT_PAGE_BYTES,
  TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
  TOOL_OUTPUT_ARTIFACT_MIN_PAGE_BYTES,
  type ToolOutputArtifactPage,
  type ToolOutputArtifactReference,
} from '@brainstrike/assistant-contract/tool-output-artifact';
import { z } from 'zod';
import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '../stream/tool-output-limits';

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const TEXT_ENCODER = new TextEncoder();

const ToolOutputArtifactReferenceSchema = z
  .object({
    byteLength: z.number().int().nonnegative(),
    expiresAt: z.string().min(1).max(64),
    format: z.enum(['json', 'text']),
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict();

const ArtifactPageSizeSchema = z
  .number()
  .int()
  .min(TOOL_OUTPUT_ARTIFACT_MIN_PAGE_BYTES)
  .max(TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES)
  .optional();

const ArtifactCursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isToolOutputArtifactCursor, 'Malformed tool output artifact cursor')
  .describe(
    'Opaque continuation cursor from the prior result. Copy it byte-for-byte; never decode, pad, edit, or recreate it.'
  );

export const ReadToolOutputArtifactCursorInputSchema = z
  .object({
    cursor: ArtifactCursorSchema,
    maxBytes: ArtifactPageSizeSchema,
  })
  .strict();

export type ReadToolOutputArtifactCursorInput = z.infer<
  typeof ReadToolOutputArtifactCursorInputSchema
>;

export const ReadToolOutputArtifactInputSchema = z
  .object({
    artifactRef: ToolOutputArtifactReferenceSchema.optional(),
    cursor: ArtifactCursorSchema.optional(),
    maxBytes: ArtifactPageSizeSchema,
    mode: z.enum(['artifact', 'cursor']),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.mode === 'artifact') {
      if (!input.artifactRef) {
        context.addIssue({
          code: 'custom',
          message: 'artifactRef is required in artifact mode.',
          path: ['artifactRef'],
        });
      }
      if (input.cursor !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'cursor must be omitted in artifact mode.',
          path: ['cursor'],
        });
      }
      return;
    }
    if (!input.cursor) {
      context.addIssue({
        code: 'custom',
        message: 'cursor is required in cursor mode.',
        path: ['cursor'],
      });
    }
    if (input.artifactRef !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'artifactRef must be omitted in cursor mode.',
        path: ['artifactRef'],
      });
    }
  });

export type ReadToolOutputArtifactInput = z.infer<typeof ReadToolOutputArtifactInputSchema>;

export type ScopedToolOutputArtifactRangeResult =
  | {
      readonly bytes: Uint8Array;
      readonly endByte: number;
      readonly offsetByte: number;
      readonly reference: ToolOutputArtifactReference;
      readonly status: 'found';
    }
  | {
      readonly reference: ToolOutputArtifactReference;
      readonly status: 'expired';
    }
  | { readonly status: 'not_found' };

/**
 * Server-created read capability whose implementation closes over the current
 * resource and thread. Model input never contains those ownership ids.
 */
export interface ScopedToolOutputArtifactReader {
  readRange(input: {
    readonly artifactId: string;
    readonly limitBytes: number;
    readonly offsetByte: number;
  }): Promise<ScopedToolOutputArtifactRangeResult>;
}

export type ToolOutputArtifactReadFailureReason =
  | 'artifact_expired'
  | 'artifact_incoherent'
  | 'artifact_not_found'
  | 'invalid_input'
  | 'malformed_cursor'
  | 'non_progress'
  | 'storage_failed';

function messageForReadFailure(reason: ToolOutputArtifactReadFailureReason): string {
  switch (reason) {
    case 'artifact_expired':
      return 'The tool output artifact has expired.';
    case 'artifact_incoherent':
      return 'The tool output artifact no longer matches its reference.';
    case 'artifact_not_found':
      return 'The tool output artifact is unavailable in this thread.';
    case 'invalid_input':
      return 'The tool output artifact read input is invalid.';
    case 'malformed_cursor':
      return 'The tool output artifact continuation cursor is malformed.';
    case 'non_progress':
      return 'The tool output artifact reader could not advance.';
    case 'storage_failed':
      return 'The tool output artifact storage read failed.';
  }
}

export class ToolOutputArtifactReadError extends Error {
  constructor(
    readonly reason: ToolOutputArtifactReadFailureReason,
    cause?: unknown
  ) {
    super(messageForReadFailure(reason), { ...(cause === undefined ? {} : { cause }) });
    this.name = 'ToolOutputArtifactReadError';
  }
}

export interface ReadToolOutputArtifactPageOptions {
  readonly now?: () => Date;
  readonly reader: ScopedToolOutputArtifactReader;
}

const TOOL_OUTPUT_ARTIFACT_READER_TOOL_ID = NATIVE_TOOL_ID.readToolOutputArtifact;

interface ToolOutputArtifactModelPage {
  readonly complete?: true;
  readonly content: string;
  readonly contentEncoding?: ToolOutputArtifactPage['contentEncoding'];
  readonly endByte: number;
  readonly format: ToolOutputArtifactReference['format'];
  readonly next?: {
    readonly input: {
      readonly cursor: string;
    };
    readonly tool: typeof TOOL_OUTPUT_ARTIFACT_READER_TOOL_ID;
  };
  readonly offsetByte: number;
}

export interface ToolOutputArtifactModelProjection {
  readonly type: 'json';
  readonly value: ToolOutputArtifactModelPage;
}

function referencesMatch(
  left: ToolOutputArtifactReference,
  right: ToolOutputArtifactReference
): boolean {
  return (
    left.id === right.id &&
    left.format === right.format &&
    left.byteLength === right.byteLength &&
    left.expiresAt === right.expiresAt
  );
}

function requireNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date && Number.isFinite(value.getTime()))) {
    throw new ToolOutputArtifactReadError(
      'storage_failed',
      new TypeError('Invalid artifact clock.')
    );
  }
  return new Date(value.getTime());
}

function decodeUtf8Prefix(bytes: Uint8Array, maximumBytes: number): string {
  const candidateLength = Math.min(bytes.byteLength, maximumBytes);
  for (let trim = 0; trim <= Math.min(3, candidateLength); trim += 1) {
    const end = candidateLength - trim;
    if (end === 0) {
      break;
    }
    try {
      return TEXT_DECODER.decode(bytes.subarray(0, end));
    } catch {}
  }
  throw new ToolOutputArtifactReadError('artifact_incoherent');
}

function serializedFieldByteLength(value: string): number {
  return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function fitProviderContent(decoded: string): {
  readonly content: string;
  readonly contentEncoding?: ToolOutputArtifactPage['contentEncoding'];
  readonly sourceByteLength: number;
} {
  const codePoints = Array.from(decoded);
  let low = 1;
  let high = codePoints.length;
  let best:
    | {
        readonly content: string;
        readonly contentEncoding?: ToolOutputArtifactPage['contentEncoding'];
        readonly sourceByteLength: number;
      }
    | undefined;

  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const source = codePoints.slice(0, kept).join('');
    const encoded = encodeToolOutputArtifactContent(source);
    if (
      encoded.content.length + 2 <= TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES &&
      serializedFieldByteLength(encoded.content) <= TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES
    ) {
      best = {
        content: encoded.content,
        ...(encoded.contentEncoding ? { contentEncoding: encoded.contentEncoding } : {}),
        sourceByteLength: TEXT_ENCODER.encode(source).byteLength,
      };
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }

  if (!best) {
    throw new ToolOutputArtifactReadError('non_progress');
  }
  return best;
}

function buildModelPage(
  page: ToolOutputArtifactPage,
  source: string
): ToolOutputArtifactModelProjection {
  const sourceByteLength = TEXT_ENCODER.encode(source).byteLength;
  const endByte = page.offsetByte + sourceByteLength;
  const encoded = encodeToolOutputArtifactContent(source);
  const nextCursor =
    endByte < page.artifactRef.byteLength
      ? encodeToolOutputArtifactCursor(page.artifactRef, endByte)
      : undefined;
  return {
    type: 'json',
    value: {
      content: encoded.content,
      ...(encoded.contentEncoding ? { contentEncoding: encoded.contentEncoding } : {}),
      endByte,
      format: page.artifactRef.format,
      ...(nextCursor
        ? {
            next: {
              input: { cursor: nextCursor },
              tool: TOOL_OUTPUT_ARTIFACT_READER_TOOL_ID,
            },
          }
        : { complete: true as const }),
      offsetByte: page.offsetByte,
    },
  };
}

/**
 * Purpose-built model projection for a raw artifact page.
 *
 * If JSON escaping plus continuation metadata would exceed the domain budget,
 * the model sees a shorter byte-exact prefix and a recomputed cursor. The raw
 * page remains unchanged for display and persistence.
 */
export function projectToolOutputArtifactPage(output: unknown): ToolOutputArtifactModelProjection {
  if (!isToolOutputArtifactPage(output)) {
    throw new TypeError('Tool output artifact reader returned an invalid page.');
  }
  const decoded = decodeToolOutputArtifactContent(output.content, output.contentEncoding);
  if (decoded.length === 0) {
    return buildModelPage(output, decoded);
  }

  // Completion replaces the comparatively large continuation cursor with one
  // boolean, so the fit predicate is not monotonic at the final code point.
  // Prefer the complete page when it fits before binary-searching the strictly
  // cursor-bearing prefixes.
  const completePage = buildModelPage(output, decoded);
  if (JSON.stringify(completePage).length <= MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
    return completePage;
  }

  const codePoints = Array.from(decoded);
  let low = 1;
  let high = codePoints.length - 1;
  let best: ToolOutputArtifactModelProjection | undefined;
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const candidate = buildModelPage(output, codePoints.slice(0, kept).join(''));
    if (JSON.stringify(candidate).length <= MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
      best = candidate;
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }
  if (!best) {
    throw new RangeError('Tool output artifact model projection could not retain one code point.');
  }
  return best;
}

function validateFoundRange(args: {
  readonly expectedBytes: number;
  readonly offsetByte: number;
  readonly reference: ToolOutputArtifactReference;
  readonly result: Extract<ScopedToolOutputArtifactRangeResult, { status: 'found' }>;
}): void {
  const { expectedBytes, offsetByte, reference, result } = args;
  if (!referencesMatch(reference, result.reference)) {
    throw new ToolOutputArtifactReadError('artifact_incoherent');
  }
  if (result.bytes.byteLength === 0 && offsetByte < reference.byteLength) {
    throw new ToolOutputArtifactReadError('non_progress');
  }
  if (
    result.offsetByte !== offsetByte ||
    result.bytes.byteLength !== expectedBytes ||
    result.endByte !== offsetByte + result.bytes.byteLength ||
    result.endByte > reference.byteLength
  ) {
    throw new ToolOutputArtifactReadError('artifact_incoherent');
  }
}

function parseReadInput(unsafeInput: unknown): ReadToolOutputArtifactInput {
  const parsed = ReadToolOutputArtifactInputSchema.safeParse(unsafeInput);
  if (parsed.success) {
    return parsed.data;
  }
  const cursorInput =
    unsafeInput && typeof unsafeInput === 'object'
      ? (unsafeInput as { cursor?: unknown; mode?: unknown })
      : undefined;
  throw new ToolOutputArtifactReadError(
    cursorInput?.mode === 'cursor' && !isToolOutputArtifactCursor(cursorInput.cursor)
      ? 'malformed_cursor'
      : 'invalid_input',
    parsed.error
  );
}

function resolveReadPosition(input: ReadToolOutputArtifactInput): {
  readonly artifactRef: ToolOutputArtifactReference;
  readonly offsetByte: number;
} {
  if (input.mode === 'artifact') {
    if (!(input.artifactRef && isToolOutputArtifactReference(input.artifactRef))) {
      throw new ToolOutputArtifactReadError('invalid_input');
    }
    return { artifactRef: input.artifactRef, offsetByte: 0 };
  }
  if (!input.cursor) {
    throw new ToolOutputArtifactReadError('malformed_cursor');
  }
  try {
    return decodeToolOutputArtifactCursor(input.cursor);
  } catch (cause) {
    throw new ToolOutputArtifactReadError('malformed_cursor', cause);
  }
}

async function readScopedRange(
  reader: ScopedToolOutputArtifactReader,
  input: {
    readonly artifactId: string;
    readonly limitBytes: number;
    readonly offsetByte: number;
  }
): Promise<ScopedToolOutputArtifactRangeResult> {
  try {
    return await reader.readRange(input);
  } catch (cause) {
    if (cause instanceof ToolOutputArtifactReadError) {
      throw cause;
    }
    throw new ToolOutputArtifactReadError('storage_failed', cause);
  }
}

function requireAvailableRange(
  result: ScopedToolOutputArtifactRangeResult,
  artifactRef: ToolOutputArtifactReference,
  now: () => Date
): Extract<ScopedToolOutputArtifactRangeResult, { status: 'found' }> {
  if (result.status === 'not_found') {
    throw new ToolOutputArtifactReadError('artifact_not_found');
  }
  if (
    !(
      isToolOutputArtifactReference(result.reference) &&
      referencesMatch(artifactRef, result.reference)
    )
  ) {
    throw new ToolOutputArtifactReadError('artifact_incoherent');
  }
  if (
    result.status === 'expired' ||
    requireNow(now).getTime() >= Date.parse(artifactRef.expiresAt)
  ) {
    throw new ToolOutputArtifactReadError('artifact_expired');
  }
  return result;
}

export async function readToolOutputArtifactPage(
  unsafeInput: unknown,
  options: ReadToolOutputArtifactPageOptions
): Promise<ToolOutputArtifactPage> {
  const input = parseReadInput(unsafeInput);
  const { artifactRef, offsetByte } = resolveReadPosition(input);
  const maxBytes = input.maxBytes ?? TOOL_OUTPUT_ARTIFACT_DEFAULT_PAGE_BYTES;
  const remainingBytes = artifactRef.byteLength - offsetByte;
  const readLimit = Math.max(1, Math.min(remainingBytes, maxBytes));
  const result = requireAvailableRange(
    await readScopedRange(options.reader, {
      artifactId: artifactRef.id,
      limitBytes: readLimit,
      offsetByte,
    }),
    artifactRef,
    options.now ?? (() => new Date())
  );

  const expectedBytes = Math.min(readLimit, remainingBytes);
  validateFoundRange({ expectedBytes, offsetByte, reference: artifactRef, result });
  if (remainingBytes === 0) {
    return {
      artifactRef,
      content: '',
      endByte: offsetByte,
      offsetByte,
    };
  }

  const decoded = decodeUtf8Prefix(result.bytes, maxBytes);
  const fitted = fitProviderContent(decoded);
  const endByte = offsetByte + fitted.sourceByteLength;
  if (endByte <= offsetByte) {
    throw new ToolOutputArtifactReadError('non_progress');
  }
  const page: ToolOutputArtifactPage = {
    artifactRef,
    content: fitted.content,
    ...(fitted.contentEncoding ? { contentEncoding: fitted.contentEncoding } : {}),
    endByte,
    ...(endByte < artifactRef.byteLength
      ? { nextCursor: encodeToolOutputArtifactCursor(artifactRef, endByte) }
      : {}),
    offsetByte,
  };
  if (!isToolOutputArtifactPage(page)) {
    throw new ToolOutputArtifactReadError('artifact_incoherent');
  }
  return page;
}
