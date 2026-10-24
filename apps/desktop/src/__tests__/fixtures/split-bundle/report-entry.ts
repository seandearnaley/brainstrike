// Built as its own entry by node-process-bundle.test.ts, beside configure-entry.ts.
import { createLogger } from '@brainstrike/logging';
import { FileContentError } from '@brainstrike/types';

const proof = (
  globalThis as unknown as {
    splitBundleProof: { configuredErrorClass: unknown; reportedError?: unknown };
  }
).splitBundleProof;

createLogger('SplitBundleProof').error('reported by the second entry');
proof.reportedError = new FileContentError(
  'created by the second entry',
  'split-bundle-proof',
  'LOADING_ERROR'
);
