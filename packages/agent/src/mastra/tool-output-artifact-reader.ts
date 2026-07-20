import {
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

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
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

export const ReadToolOutputArtifactInputSchema = z.discriminatedUnion('mode', [
  z
    .object({
      artifactRef: ToolOutputArtifactReferenceSchema,
      maxBytes: ArtifactPageSizeSchema,
      mode: z.literal('artifact'),
    })
    .strict(),
  z
    .object({
      cursor: z
        .string()
        .min(1)
        .max(2048)
        .refine(isToolOutputArtifactCursor, 'Malformed tool output artifact cursor'),
      maxBytes: ArtifactPageSizeSchema,
      mode: z.literal('cursor'),
    })
    .strict(),
]);

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
    if (!isToolOutputArtifactReference(input.artifactRef)) {
      throw new ToolOutputArtifactReadError('invalid_input');
    }
    return { artifactRef: input.artifactRef, offsetByte: 0 };
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
  const readLimit = Math.max(
    1,
    Math.min(TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES, remainingBytes, maxBytes + 3)
  );
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
