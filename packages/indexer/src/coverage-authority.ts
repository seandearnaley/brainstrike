import { Schema } from 'effect';
import {
  fileBindingsSchema,
  IndexerError,
  optionsSchema,
  scopedProofIdentitySchema,
  scopeSchema,
} from './contracts.js';
export const coverageAuthoritySchema = Schema.Struct({
  ...scopedProofIdentitySchema.fields,
  dbPath: optionsSchema.fields.dbPath,
  fileBindings: fileBindingsSchema,
  rootIds: optionsSchema.fields.rootIds,
  scopes: Schema.Array(scopeSchema),
});
export type CoverageAuthority = typeof coverageAuthoritySchema.Type;
export interface CoverageAuthorityPort {
  coverageAuthority(): Promise<CoverageAuthority>;
}
/** Trusted coverage authority has its own bound; generic SQL budgets are unchanged. */
export const MAX_NATIVE_COVERAGE_AUTHORITY_BYTES = 32 * 1024 * 1024;
/** The desktop's native message codec; this module is also part of the browser's derived index. */
const v8 = globalThis.process?.getBuiltinModule?.('node:v8');
export function assertCoverageAuthorityBound(input: unknown): number {
  if (!v8) {
    throw new Error(
      'The native coverage message budget is measured with node:v8, which this runtime lacks.'
    );
  }
  const bytes = v8.serialize(input).byteLength;
  if (bytes > MAX_NATIVE_COVERAGE_AUTHORITY_BYTES) {
    throw new RangeError('Native coverage authority exceeds its 32 MiB message budget.');
  }
  return bytes;
}

export function assertCoverageAuthority(
  current: Pick<CoverageAuthority, 'storeId' | 'authorityEpoch' | 'authorityRevision'>,
  expected: Pick<CoverageAuthority, 'storeId' | 'authorityEpoch' | 'authorityRevision'>
): void {
  if (current.storeId !== expected.storeId) {
    throw new IndexerError(
      'coverage-store-mismatch',
      'Native coverage returned a different store from its owned authority.'
    );
  }
  if (
    current.authorityEpoch !== expected.authorityEpoch ||
    current.authorityRevision !== expected.authorityRevision
  ) {
    throw new IndexerError(
      'coverage-authority-changed',
      'Native coverage authority changed during its owned observation.'
    );
  }
}
