import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import {
  authorize,
  decoder,
  type IndexerManifestResult,
  manifestFileSchema,
  manifestRequestSchema,
  manifestResultSchema,
} from './contracts.js';
import { readIndexIdentity } from './index-metadata.js';
import { isAbsolutePosix } from './portable.js';

interface ManifestComparison<T> {
  changed: T[];
  complete: boolean;
  missing: T[];
  unexpected: T[];
}
export function compareManifest<T extends { fileId: string }>(
  expected: ReadonlyMap<string, T>,
  actual: readonly T[],
  differs: (expected: T, stored: T) => boolean
): ManifestComparison<T> {
  const indexed = new Map(actual.map((file) => [file.fileId, file]));
  const missing: T[] = [];
  const changed: T[] = [];
  for (const file of expected.values()) {
    const stored = indexed.get(file.fileId);
    if (!stored) {
      missing.push(file);
    } else if (differs(file, stored)) {
      changed.push(file);
    }
  }
  const unexpected = actual.filter((file) => !expected.has(file.fileId));
  return {
    changed,
    complete: missing.length === 0 && changed.length === 0 && unexpected.length === 0,
    missing,
    unexpected,
  };
}

/** One read snapshot compares exact canonical identities; it never publishes scan readiness. */
export function verifyIndexManifest(
  db: Database.Database,
  allowed: ReadonlySet<string>,
  input: unknown
): IndexerManifestResult {
  const request = decoder(manifestRequestSchema)(input);
  authorize(allowed, [request.rootId]);
  const expected = new Map<string, typeof manifestFileSchema.Type>();
  const paths = new Set<string>();
  for (const file of request.files) {
    if (
      expected.has(file.fileId) ||
      paths.has(file.relativePath) ||
      isAbsolutePosix(file.relativePath) ||
      file.relativePath.includes('\\') ||
      file.relativePath
        .split('/')
        .some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new TypeError(
        'Canonical manifest requires unique file IDs and normalized relative paths.'
      );
    }
    expected.set(file.fileId, file);
    paths.add(file.relativePath);
  }
  return db.transaction(() => {
    const actual = decoder(Schema.Array(manifestFileSchema))(
      db
        .prepare(
          'SELECT id AS fileId,path AS relativePath,content_hash AS contentHash FROM file_records WHERE root_id=? ORDER BY id'
        )
        .all(request.rootId)
    );
    return decoder(manifestResultSchema)({
      ...readIndexIdentity(db),
      ...compareManifest(
        expected,
        actual,
        (file, stored) =>
          stored.relativePath !== file.relativePath || stored.contentHash !== file.contentHash
      ),
      rootId: request.rootId,
    });
  })();
}
