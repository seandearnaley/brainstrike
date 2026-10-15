/** Trusted native coverage only; never an arbitrary SQL capability. */
import { decoder, type ScopedCoverage } from './contracts.js';
import { coverageAuthoritySchema } from './coverage-authority.js';
import { openDesktopIndexReader } from './desktop-index-connection.js';
import { scopeCoverageBatch } from './scoped-proofs.js';
import { IndexReader } from './store.js';

export {
  fault,
  faultSchema,
  scopedCoverageBatchRequestSchema,
  scopedCoverageSchema,
} from './contracts.js';
export {
  assertCoverageAuthority,
  assertCoverageAuthorityBound,
  type CoverageAuthority,
  type CoverageAuthorityPort,
  coverageAuthoritySchema,
  MAX_NATIVE_COVERAGE_AUTHORITY_BYTES,
} from './coverage-authority.js';
export function readNativeCoverage(
  authorityInput: unknown,
  requests: unknown
): readonly ScopedCoverage[] {
  const authority = decoder(coverageAuthoritySchema)(authorityInput);
  const options = {
    dbPath: authority.dbPath,
    embedding: { indexMode: 'open-existing' },
    fileBindings: authority.fileBindings,
    rootIds: authority.rootIds,
    scopes: authority.scopes,
  };
  const reader = new IndexReader(options, openDesktopIndexReader(options));
  try {
    reader.scoped.authority.revision = authority.authorityRevision;
    return scopeCoverageBatch(reader.db, reader.scoped.authority, requests, authority);
  } finally {
    reader.db.close();
  }
}
