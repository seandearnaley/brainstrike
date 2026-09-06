import { createHash } from 'node:crypto';
import {
  type McpArtifactKind,
  type McpEvidenceSchema,
  parseMcpEvidenceSchema,
} from './evidence-schema.js';

export type McpArtifactIntegrityCode =
  | 'artifact_decode_failed'
  | 'artifact_hash_mismatch'
  | 'artifact_read_failed'
  | 'artifact_too_large'
  | 'invalid_artifact_limit'
  | 'invalid_artifact_content'
  | 'screenshot_extraction_failed'
  | 'screenshot_extractor_missing'
  | 'screenshot_metadata_extraction_failed'
  | 'screenshot_metadata_extractor_missing';

export class McpArtifactIntegrityError extends Error {
  readonly code: McpArtifactIntegrityCode;
  readonly reference: string;

  constructor(code: McpArtifactIntegrityCode, reference: string, message: string) {
    super(`${reference}: ${message}`);
    this.name = 'McpArtifactIntegrityError';
    this.code = code;
    this.reference = reference;
  }
}

export interface McpArtifactIntegrityDependencies {
  readonly extractScreenshotMetadata?: (
    bytes: Uint8Array,
    reference: string
  ) => Promise<string> | string;
  readonly extractScreenshotText?: (
    bytes: Uint8Array,
    reference: string
  ) => Promise<string> | string;
  readonly maxArtifactBytes: number;
  readonly readArtifactContent: (
    reference: string,
    maxBytes: number
  ) => Promise<Uint8Array> | Uint8Array;
}

export interface McpVerifiedArtifact {
  readonly extractedText: string;
  readonly kind: McpArtifactKind;
  readonly reference: string;
  readonly sha256: string;
}

export interface McpArtifactIntegrityResult {
  readonly artifacts: readonly McpVerifiedArtifact[];
  readonly schema: McpEvidenceSchema;
}

export type McpExtractedTextVerifier = (text: string, artifactIndex: number) => void;

export async function verifyMcpEvidenceArtifactIntegrity(
  input: unknown,
  dependencies: McpArtifactIntegrityDependencies
): Promise<McpArtifactIntegrityResult> {
  const schema = parseMcpEvidenceSchema(input);
  return verifyParsedMcpEvidenceArtifactIntegrity(schema, dependencies, () => undefined);
}

export async function verifyParsedMcpEvidenceArtifactIntegrity(
  schema: McpEvidenceSchema,
  dependencies: McpArtifactIntegrityDependencies,
  verifyExtractedText: McpExtractedTextVerifier
): Promise<McpArtifactIntegrityResult> {
  const maxArtifactBytes = validateArtifactLimit(dependencies.maxArtifactBytes);
  const artifacts: McpVerifiedArtifact[] = [];
  // Schema uniqueness plus sequential reads preserve read-once behavior,
  // deterministic error ordering, and a bounded in-flight working set.
  for (const [index, artifact] of schema.artifacts.entries()) {
    const bytes = await readArtifactOnce(
      artifact.reference,
      maxArtifactBytes,
      dependencies.readArtifactContent
    );
    assertDigest(bytes, artifact.reference, artifact.sha256);
    const extractedText = await extractArtifactText(
      artifact.kind,
      artifact.reference,
      bytes,
      dependencies.extractScreenshotMetadata,
      dependencies.extractScreenshotText
    );
    verifyExtractedText(extractedText, index);
    artifacts.push({
      extractedText,
      kind: artifact.kind,
      reference: artifact.reference,
      sha256: artifact.sha256,
    });
  }
  return { artifacts, schema };
}

async function readArtifactOnce(
  reference: string,
  maxBytes: number,
  reader: McpArtifactIntegrityDependencies['readArtifactContent']
): Promise<Uint8Array> {
  let value: Uint8Array;
  try {
    value = await reader(reference, maxBytes);
  } catch (error) {
    const code = filesystemErrorCode(error);
    fail('artifact_read_failed', reference, `artifact reader failed${code ? ` (${code})` : ''}`);
  }
  if (!(value instanceof Uint8Array)) {
    fail('invalid_artifact_content', reference, 'artifact reader must return bytes');
  }
  let byteLength: number;
  try {
    byteLength = value.byteLength;
  } catch {
    fail('invalid_artifact_content', reference, 'artifact byte length could not be read');
  }
  if (byteLength > maxBytes) {
    fail('artifact_too_large', reference, 'artifact exceeds the configured byte limit');
  }
  try {
    return new Uint8Array(value);
  } catch {
    fail('invalid_artifact_content', reference, 'artifact bytes could not be copied');
  }
}

function assertDigest(bytes: Uint8Array, reference: string, expected: string): void {
  let actual: string;
  try {
    actual = createHash('sha256').update(bytes).digest('hex');
  } catch {
    fail('invalid_artifact_content', reference, 'artifact bytes could not be hashed');
  }
  if (actual !== expected) {
    fail('artifact_hash_mismatch', reference, 'artifact SHA-256 does not match evidence');
  }
}

async function extractArtifactText(
  kind: McpArtifactKind,
  reference: string,
  bytes: Uint8Array,
  screenshotMetadataExtractor: McpArtifactIntegrityDependencies['extractScreenshotMetadata'],
  screenshotExtractor: McpArtifactIntegrityDependencies['extractScreenshotText']
): Promise<string> {
  if (kind !== 'screenshot') {
    return decodeArtifactText(bytes, reference);
  }
  if (screenshotExtractor === undefined) {
    fail('screenshot_extractor_missing', reference, 'screenshot text extractor is required');
  }
  if (screenshotMetadataExtractor === undefined) {
    fail(
      'screenshot_metadata_extractor_missing',
      reference,
      'screenshot metadata extractor is required'
    );
  }
  let metadata: string;
  try {
    metadata = await screenshotMetadataExtractor(new Uint8Array(bytes), reference);
  } catch {
    fail(
      'screenshot_metadata_extraction_failed',
      reference,
      'screenshot metadata extraction failed'
    );
  }
  if (typeof metadata !== 'string') {
    fail(
      'screenshot_metadata_extraction_failed',
      reference,
      'screenshot metadata extraction returned invalid data'
    );
  }
  let extracted: string;
  try {
    extracted = await screenshotExtractor(new Uint8Array(bytes), reference);
  } catch {
    fail('screenshot_extraction_failed', reference, 'screenshot text extraction failed');
  }
  if (typeof extracted !== 'string') {
    fail(
      'screenshot_extraction_failed',
      reference,
      'screenshot text extraction returned invalid data'
    );
  }
  return `${extracted}\n${metadata}`;
}

function decodeArtifactText(bytes: Uint8Array, reference: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('artifact_decode_failed', reference, 'artifact is not valid UTF-8');
  }
}

const SAFE_FILESYSTEM_ERROR_CODES = new Set([
  'EACCES',
  'EISDIR',
  'EMFILE',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
]);

function filesystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  let code: unknown;
  try {
    code = Reflect.get(error, 'code');
  } catch {
    return undefined;
  }
  return typeof code === 'string' && SAFE_FILESYSTEM_ERROR_CODES.has(code) ? code : undefined;
}

function validateArtifactLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(
      'invalid_artifact_limit',
      '$.dependencies.maxArtifactBytes',
      'artifact byte limit must be a positive safe integer'
    );
  }
  return value;
}

function fail(code: McpArtifactIntegrityCode, reference: string, message: string): never {
  throw new McpArtifactIntegrityError(code, reference, message);
}
