import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {'pre-stream' | 'stream'} MeasurementVariant */

export const BST372_HISTORICAL_SOURCE_BINDINGS = Object.freeze({
  'pre-stream': Object.freeze({
    commit: '13541685dc1586efea302440041965efd807440a',
    sourceBlobs: Object.freeze({
      'src/embedding.worker.ts': 'e0ed795e41428555de2c5b77e3d005b8beb398cf',
      'src/shared.ts': '0970779a73f979e32d4833afcaded232ceb01961',
    }),
  }),
  stream: Object.freeze({
    commit: 'f983a0ed0ee0fc3581060f61c2f6fcb8bfed9d32',
    sourceBlobs: Object.freeze({
      'src/embedding.worker.ts': '1ebfe5182583f2f8207a4bdc41654d212eb28d07',
      'src/shared.ts': 'c62a34673eca59dbe14102f2e7101a4d255ada9e',
    }),
  }),
});

/**
 * Compute the object ID Git assigns to raw blob contents.
 *
 * @param {Uint8Array} contents
 * @returns {string}
 */
export function computeGitBlobId(contents) {
  const header = Buffer.from(`blob ${contents.byteLength}\0`);
  return createHash('sha1').update(header).update(contents).digest('hex');
}

/**
 * @param {unknown} value
 * @returns {MeasurementVariant}
 */
export function parseMeasurementVariant(value) {
  if (value === 'pre-stream' || value === 'stream') {
    return value;
  }
  throw new Error('BST372_VARIANT must be pre-stream or stream.');
}

/**
 * Verify that a measurement tree contains the exact production sources assigned to its
 * variant. The returned revision metadata is derived from the verified binding; callers
 * never supply a commit label separately.
 *
 * @param {{
 *   bindings?: Readonly<Record<MeasurementVariant, {
 *     commit: string;
 *     sourceBlobs: Readonly<Record<string, string>>;
 *   }>>;
 *   packageRoot: string;
 *   variant: MeasurementVariant;
 * }} options
 * @returns {{
 *   commit: string;
 *   sourceBlobs: Readonly<Record<string, string>>;
 *   variant: MeasurementVariant;
 * }}
 */
export function verifyHistoricalSourceBinding({
  bindings = BST372_HISTORICAL_SOURCE_BINDINGS,
  packageRoot,
  variant,
}) {
  const binding = bindings[variant];
  if (!binding) {
    throw new Error(`No BST-372 historical source binding exists for ${variant}.`);
  }
  const sourceEntries = Object.entries(binding.sourceBlobs);
  if (sourceEntries.length === 0) {
    throw new Error(`BST-372 historical source binding for ${variant} has no source blobs.`);
  }

  const actualSourceBlobs = {};
  for (const [relativePath, expectedBlob] of sourceEntries) {
    const contents = readFileSync(join(packageRoot, relativePath));
    const actualBlob = computeGitBlobId(contents);
    if (actualBlob !== expectedBlob) {
      throw new Error(
        `BST-372 historical source mismatch for ${relativePath}: expected Git blob ${expectedBlob} for ${variant} (${binding.commit}), received ${actualBlob}. Refusing to measure.`
      );
    }
    actualSourceBlobs[relativePath] = actualBlob;
  }

  return Object.freeze({
    commit: binding.commit,
    sourceBlobs: Object.freeze(actualSourceBlobs),
    variant,
  });
}
