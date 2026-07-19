export const TOOL_OUTPUT_ARTIFACT_CODE = 'tool_output_artifact' as const;
export const TOOL_OUTPUT_ARTIFACT_VERSION = 1 as const;
export const TOOL_OUTPUT_ARTIFACT_CURSOR_PREFIX = 'bsto1.' as const;
export const TOOL_OUTPUT_ARTIFACT_JSON_STRING_ENCODING = 'json-string' as const;
export const TOOL_OUTPUT_ARTIFACT_DEFAULT_PAGE_BYTES = 6000;
export const TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES = 8000;
export const TOOL_OUTPUT_ARTIFACT_MIN_PAGE_BYTES = 4;

const ARTIFACT_ID_MAX_CHARS = 128;
const CURSOR_MAX_CHARS = 2048;
const HINT_MAX_CHARS = 2000;
const TEXT_ENCODER = new TextEncoder();
const ARTIFACT_REFERENCE_KEYS = new Set(['byteLength', 'expiresAt', 'format', 'id']);
const ARTIFACT_ENVELOPE_KEYS = new Set([
  'artifactRef',
  'code',
  'contentEncoding',
  'hint',
  'nextCursor',
  'preview',
  'truncated',
  'version',
]);
const ARTIFACT_ENVELOPE_REQUIRED_KEYS = new Set([
  'artifactRef',
  'code',
  'hint',
  'nextCursor',
  'preview',
  'truncated',
  'version',
]);
const ARTIFACT_PAGE_KEYS = new Set([
  'artifactRef',
  'content',
  'contentEncoding',
  'endByte',
  'nextCursor',
  'offsetByte',
]);
const ARTIFACT_PAGE_REQUIRED_KEYS = new Set(['artifactRef', 'content', 'endByte', 'offsetByte']);

export type ToolOutputArtifactFormat = 'json' | 'text';
export type ToolOutputArtifactContentEncoding = typeof TOOL_OUTPUT_ARTIFACT_JSON_STRING_ENCODING;

/**
 * Opaque pointer to a durable tool result.
 *
 * The identifier deliberately cannot encode a path, URL, thread id, or storage
 * location. Resolution must happen through the current request scope.
 */
export interface ToolOutputArtifactReference {
  readonly byteLength: number;
  readonly expiresAt: string;
  readonly format: ToolOutputArtifactFormat;
  readonly id: string;
}

/**
 * Bounded provider-facing result returned after complete output is retained.
 *
 * `preview` contains the first decoded UTF-8 bytes of the artifact and
 * `nextCursor` resumes immediately after them.
 */
export interface ToolOutputArtifactEnvelope {
  readonly artifactRef: ToolOutputArtifactReference;
  readonly code: typeof TOOL_OUTPUT_ARTIFACT_CODE;
  readonly contentEncoding?: ToolOutputArtifactContentEncoding;
  readonly hint: string;
  readonly nextCursor: string;
  readonly preview: string;
  readonly truncated: true;
  readonly version: typeof TOOL_OUTPUT_ARTIFACT_VERSION;
}

/** One contiguous, byte-addressed artifact page. */
export interface ToolOutputArtifactPage {
  readonly artifactRef: ToolOutputArtifactReference;
  readonly content: string;
  readonly contentEncoding?: ToolOutputArtifactContentEncoding;
  readonly endByte: number;
  readonly nextCursor?: string;
  readonly offsetByte: number;
}

export interface EncodedToolOutputArtifactContent {
  readonly content: string;
  readonly contentEncoding?: ToolOutputArtifactContentEncoding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: ReadonlySet<string> = allowedKeys
): boolean {
  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    [...requiredKeys].every((key) => Object.hasOwn(value, key))
  );
}

function isNonEmptyBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isOpaqueToken(value: unknown, maximum: number): value is string {
  return isNonEmptyBoundedString(value, maximum) && /^[A-Za-z0-9_-]+$/u.test(value);
}

function isIsoInstant(value: unknown): value is string {
  if (!isNonEmptyBoundedString(value, 64)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function utf8ByteLength(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}

/**
 * Preserve content that PostgreSQL jsonb cannot represent directly.
 *
 * PostgreSQL rejects U+0000 after JSON unescaping. Encoding the affected slice
 * as a JSON string literal keeps the outer persisted value lossless.
 */
export function encodeToolOutputArtifactContent(content: string): EncodedToolOutputArtifactContent {
  if (!content.includes('\u0000')) {
    return { content };
  }
  return {
    content: JSON.stringify(content),
    contentEncoding: TOOL_OUTPUT_ARTIFACT_JSON_STRING_ENCODING,
  };
}

export function decodeToolOutputArtifactContent(
  content: string,
  contentEncoding?: ToolOutputArtifactContentEncoding
): string {
  if (contentEncoding === undefined) {
    if (content.includes('\u0000')) {
      throw new TypeError('Unencoded tool output artifact content contains U+0000.');
    }
    return content;
  }
  if (contentEncoding !== TOOL_OUTPUT_ARTIFACT_JSON_STRING_ENCODING) {
    throw new TypeError('Unsupported tool output artifact content encoding.');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(content) as unknown;
  } catch {
    throw new TypeError('JSON-string tool output artifact content is malformed.');
  }
  if (typeof decoded !== 'string') {
    throw new TypeError('JSON-string tool output artifact content must decode to a string.');
  }
  return decoded;
}

function readDecodedContent(content: unknown, contentEncoding: unknown): string | undefined {
  if (
    typeof content !== 'string' ||
    (contentEncoding !== undefined && contentEncoding !== TOOL_OUTPUT_ARTIFACT_JSON_STRING_ENCODING)
  ) {
    return;
  }
  if (
    content.length > TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES ||
    utf8ByteLength(content) > TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES
  ) {
    return;
  }
  try {
    return decodeToolOutputArtifactContent(content, contentEncoding);
  } catch {
    return;
  }
}

export function isToolOutputArtifactCursor(value: unknown): value is string {
  if (
    !(
      isNonEmptyBoundedString(value, CURSOR_MAX_CHARS) &&
      value.startsWith(TOOL_OUTPUT_ARTIFACT_CURSOR_PREFIX)
    )
  ) {
    return false;
  }
  return isOpaqueToken(value.slice(TOOL_OUTPUT_ARTIFACT_CURSOR_PREFIX.length), CURSOR_MAX_CHARS);
}

export function isToolOutputArtifactReference(
  value: unknown
): value is ToolOutputArtifactReference {
  if (!(isRecord(value) && hasOnlyKeys(value, ARTIFACT_REFERENCE_KEYS))) {
    return false;
  }
  return (
    isOpaqueToken(value['id'], ARTIFACT_ID_MAX_CHARS) &&
    (value['format'] === 'json' || value['format'] === 'text') &&
    typeof value['byteLength'] === 'number' &&
    Number.isSafeInteger(value['byteLength']) &&
    value['byteLength'] >= 0 &&
    isIsoInstant(value['expiresAt'])
  );
}

export function isToolOutputArtifactEnvelope(value: unknown): value is ToolOutputArtifactEnvelope {
  if (
    !(
      isRecord(value) && hasOnlyKeys(value, ARTIFACT_ENVELOPE_KEYS, ARTIFACT_ENVELOPE_REQUIRED_KEYS)
    )
  ) {
    return false;
  }
  if (
    value['code'] !== TOOL_OUTPUT_ARTIFACT_CODE ||
    value['version'] !== TOOL_OUTPUT_ARTIFACT_VERSION ||
    value['truncated'] !== true ||
    !isToolOutputArtifactReference(value['artifactRef']) ||
    !isNonEmptyBoundedString(value['hint'], HINT_MAX_CHARS) ||
    !isToolOutputArtifactCursor(value['nextCursor'])
  ) {
    return false;
  }

  const contentEncoding = Object.hasOwn(value, 'contentEncoding')
    ? value['contentEncoding']
    : undefined;
  const preview = readDecodedContent(value['preview'], contentEncoding);
  if (preview === undefined) {
    return false;
  }
  const previewBytes = utf8ByteLength(preview);
  return (
    previewBytes > 0 &&
    previewBytes <= TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES &&
    previewBytes < value['artifactRef'].byteLength
  );
}

export function isToolOutputArtifactPage(value: unknown): value is ToolOutputArtifactPage {
  if (!(isRecord(value) && hasOnlyKeys(value, ARTIFACT_PAGE_KEYS, ARTIFACT_PAGE_REQUIRED_KEYS))) {
    return false;
  }
  if (!isToolOutputArtifactReference(value['artifactRef'])) {
    return false;
  }

  const offsetByte = value['offsetByte'];
  const endByte = value['endByte'];
  if (
    typeof offsetByte !== 'number' ||
    !Number.isSafeInteger(offsetByte) ||
    offsetByte < 0 ||
    typeof endByte !== 'number' ||
    !Number.isSafeInteger(endByte) ||
    endByte < offsetByte ||
    endByte > value['artifactRef'].byteLength
  ) {
    return false;
  }

  const contentEncoding = Object.hasOwn(value, 'contentEncoding')
    ? value['contentEncoding']
    : undefined;
  const content = readDecodedContent(value['content'], contentEncoding);
  if (content === undefined) {
    return false;
  }
  const contentBytes = utf8ByteLength(content);
  if (
    contentBytes > TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES ||
    contentBytes !== endByte - offsetByte ||
    (value['artifactRef'].byteLength > 0 && endByte === offsetByte)
  ) {
    return false;
  }

  const hasMore = endByte < value['artifactRef'].byteLength;
  const nextCursor = Object.hasOwn(value, 'nextCursor') ? value['nextCursor'] : undefined;
  return hasMore ? isToolOutputArtifactCursor(nextCursor) : nextCursor === undefined;
}
