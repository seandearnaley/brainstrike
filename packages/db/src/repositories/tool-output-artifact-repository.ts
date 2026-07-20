import {
  isToolOutputArtifactReference,
  TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
  type ToolOutputArtifactFormat,
  type ToolOutputArtifactReference,
} from '@brainstrike/assistant-contract/tool-output-artifact';

const TABLE = 'brainstrike_assistant_tool_output_artifacts';
const OWNER_ID_MAX_BYTES = 512;
const DEFAULT_PURGE_LIMIT = 500;
const MAX_PURGE_LIMIT = 10_000;
const TEXT_ENCODER = new TextEncoder();
const HEX_BYTES = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

export const TOOL_OUTPUT_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type ToolOutputArtifactStorageOperation = 'purge' | 'read' | 'store';

export class ToolOutputArtifactStorageError extends Error {
  readonly operation: ToolOutputArtifactStorageOperation;

  constructor(operation: ToolOutputArtifactStorageOperation, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to ${operation} tool output artifact${detail ? `: ${detail}` : ''}`, { cause });
    this.name = 'ToolOutputArtifactStorageError';
    this.operation = operation;
  }
}

export interface ToolOutputArtifactDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface StoreToolOutputArtifactInput {
  readonly content: string;
  readonly format: ToolOutputArtifactFormat;
  readonly resourceId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId: string;
}

export interface ReadToolOutputArtifactRangeInput {
  readonly artifactId: string;
  readonly limitBytes: number;
  readonly offsetByte: number;
  readonly resourceId: string;
  readonly threadId: string;
}

export type ToolOutputArtifactRangeResult =
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

export interface PurgeExpiredToolOutputArtifactsOptions {
  readonly limit?: number;
}

export interface ToolOutputArtifactRepositoryOptions {
  readonly now?: () => Date;
}

interface ArtifactReferenceRow {
  byteLength: number | string;
  expiresAt: Date | string;
  format: unknown;
  id: unknown;
}

interface ArtifactRangeRow extends ArtifactReferenceRow {
  content: unknown;
}

function requireOwnerId(value: string, field: string): void {
  const byteLength = TEXT_ENCODER.encode(value).byteLength;
  if (byteLength === 0 || byteLength > OWNER_ID_MAX_BYTES) {
    throw new TypeError(
      `Tool output artifact ${field} must contain 1-${OWNER_ID_MAX_BYTES} UTF-8 bytes.`
    );
  }
}

function requireOpaqueArtifactId(value: string): void {
  if (value.length === 0 || value.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError('Tool output artifact id must be an opaque token.');
  }
}

function requireSafeNonNegativeInteger(value: number, field: string): void {
  if (!(Number.isSafeInteger(value) && value >= 0)) {
    throw new RangeError(`Tool output artifact ${field} must be a non-negative safe integer.`);
  }
}

function requirePositiveInteger(value: number, field: string, maximum: number): void {
  if (!(Number.isSafeInteger(value) && value > 0 && value <= maximum)) {
    throw new RangeError(
      `Tool output artifact ${field} must be an integer between 1 and ${maximum}.`
    );
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    let chunk = '';
    const end = Math.min(offset + chunkSize, bytes.length);
    for (let index = offset; index < end; index += 1) {
      const byte = bytes[index];
      const encoded = byte === undefined ? undefined : HEX_BYTES[byte];
      if (encoded === undefined) {
        throw new TypeError('Tool output artifact byte encoding encountered an invalid byte.');
      }
      chunk += encoded;
    }
    hex += chunk;
  }
  return hex;
}

function canonicalInstant(value: Date | string, field: string): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`Tool output artifact ${field} is not a valid timestamp.`);
  }
  return date.toISOString();
}

function requireNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date && Number.isFinite(value.getTime()))) {
    throw new TypeError('Tool output artifact clock returned an invalid Date.');
  }
  return new Date(value.getTime());
}

function referenceFromRow(row: ArtifactReferenceRow): ToolOutputArtifactReference {
  const byteLength = Number(row.byteLength);
  const reference = {
    byteLength,
    expiresAt: canonicalInstant(row.expiresAt, 'expiresAt'),
    format: row.format,
    id: row.id,
  };
  if (!isToolOutputArtifactReference(reference)) {
    throw new TypeError('Tool output artifact storage returned an invalid reference.');
  }
  return reference;
}

/**
 * PGlite-backed complete-output store.
 *
 * Settlement writes complete UTF-8 content before it publishes a bounded
 * artifact envelope. Reads are resource+thread scoped and byte-bounded; the
 * later resolver layer owns UTF-8 boundary adjustment and cursor validation.
 */
export class ToolOutputArtifactRepository {
  private readonly now: () => Date;

  constructor(
    private readonly db: ToolOutputArtifactDatabase,
    options: ToolOutputArtifactRepositoryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async store(input: StoreToolOutputArtifactInput): Promise<ToolOutputArtifactReference> {
    requireOwnerId(input.resourceId, 'resourceId');
    requireOwnerId(input.threadId, 'threadId');
    requireOwnerId(input.runId, 'runId');
    requireOwnerId(input.toolCallId, 'toolCallId');
    if (input.format !== 'json' && input.format !== 'text') {
      throw new TypeError('Tool output artifact format must be json or text.');
    }

    const createdAt = requireNow(this.now);
    const expiresAt = new Date(createdAt.getTime() + TOOL_OUTPUT_ARTIFACT_RETENTION_MS);
    // Deliberately uncapped here: the settlement boundary owns the host policy
    // cap, while this repository guarantees complete byte-exact retention.
    const content = TEXT_ENCODER.encode(input.content);
    if (!Number.isSafeInteger(content.byteLength)) {
      throw new RangeError('Tool output artifact content exceeds the safe byte-length range.');
    }

    try {
      const result = await this.db.query<ArtifactReferenceRow>(
        `INSERT INTO ${TABLE} (
           resource_id, thread_id, run_id, tool_call_id, format,
           content, byte_length, created_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), $7, $8, $9)
         ON CONFLICT (resource_id, thread_id, run_id, tool_call_id)
         DO UPDATE SET tool_call_id = EXCLUDED.tool_call_id
         WHERE ${TABLE}.format = EXCLUDED.format
           AND ${TABLE}.content = EXCLUDED.content
         RETURNING
           id,
           format,
           byte_length AS "byteLength",
           expires_at AS "expiresAt"`,
        [
          input.resourceId,
          input.threadId,
          input.runId,
          input.toolCallId,
          input.format,
          bytesToHex(content),
          content.byteLength,
          createdAt.toISOString(),
          expiresAt.toISOString(),
        ]
      );
      const row = result.rows[0];
      if (!row) {
        throw new TypeError('Tool output artifact insert returned no reference.');
      }
      return referenceFromRow(row);
    } catch (cause) {
      throw new ToolOutputArtifactStorageError('store', cause);
    }
  }

  async readRange(input: ReadToolOutputArtifactRangeInput): Promise<ToolOutputArtifactRangeResult> {
    requireOpaqueArtifactId(input.artifactId);
    requireOwnerId(input.resourceId, 'resourceId');
    requireOwnerId(input.threadId, 'threadId');
    requireSafeNonNegativeInteger(input.offsetByte, 'offsetByte');
    requirePositiveInteger(input.limitBytes, 'limitBytes', TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES);
    const now = requireNow(this.now);

    try {
      const result = await this.db.query<ArtifactRangeRow>(
        `SELECT
           id,
           format,
           byte_length AS "byteLength",
           expires_at AS "expiresAt",
           CASE
             WHEN expires_at > $6
             THEN substring(content FROM ($4::integer + 1) FOR $5::integer)
             ELSE NULL
           END AS content
         FROM ${TABLE}
         WHERE id = $1
           AND resource_id = $2
           AND thread_id = $3`,
        [
          input.artifactId,
          input.resourceId,
          input.threadId,
          input.offsetByte,
          input.limitBytes,
          now.toISOString(),
        ]
      );
      const row = result.rows[0];
      if (!row) {
        return { status: 'not_found' };
      }

      const reference = referenceFromRow(row);
      if (now.getTime() >= Date.parse(reference.expiresAt)) {
        return { reference, status: 'expired' };
      }
      if (input.offsetByte > reference.byteLength) {
        throw new RangeError('Tool output artifact offsetByte exceeds the artifact byte length.');
      }
      if (!(row.content instanceof Uint8Array)) {
        throw new TypeError('Tool output artifact storage returned invalid byte content.');
      }

      const expectedBytes = Math.min(input.limitBytes, reference.byteLength - input.offsetByte);
      if (row.content.byteLength !== expectedBytes) {
        throw new TypeError('Tool output artifact storage returned an incoherent byte range.');
      }
      return {
        bytes: row.content,
        endByte: input.offsetByte + row.content.byteLength,
        offsetByte: input.offsetByte,
        reference,
        status: 'found',
      };
    } catch (cause) {
      if (cause instanceof RangeError) {
        throw cause;
      }
      throw new ToolOutputArtifactStorageError('read', cause);
    }
  }

  async purgeExpired(options: PurgeExpiredToolOutputArtifactsOptions = {}): Promise<number> {
    const limit = options.limit ?? DEFAULT_PURGE_LIMIT;
    requirePositiveInteger(limit, 'purge limit', MAX_PURGE_LIMIT);
    const now = requireNow(this.now);

    try {
      const result = await this.db.query<{ id: string }>(
        `DELETE FROM ${TABLE}
         WHERE id IN (
           SELECT id
           FROM ${TABLE}
           WHERE expires_at <= $1
           ORDER BY expires_at ASC, id ASC
           LIMIT $2
         )
         RETURNING id`,
        [now.toISOString(), limit]
      );
      return result.rows.length;
    } catch (cause) {
      throw new ToolOutputArtifactStorageError('purge', cause);
    }
  }
}
