// Built as its own entry by node-process-bundle.test.ts, beside configure-entry.ts.
import { createLogger } from '@brainstrike/logging';
import { BrainStrikeError } from '@brainstrike/utils';

const proof = (
  globalThis as unknown as {
    splitBundleProof: { configuredErrorClass: unknown; reportedError?: unknown };
  }
).splitBundleProof;

createLogger('SplitBundleProof').error('reported by the second entry');
proof.reportedError = new BrainStrikeError('SPLIT_BUNDLE_PROOF', 'created by the second entry');
