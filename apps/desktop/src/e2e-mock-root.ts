import path from 'node:path';

/**
 * Desktop E2E serves its synthetic file tree under the host's own `/mock`, so
 * on Windows it is `C:\mock\...` with `\` separators. Main's file-system domain
 * reads it from the test fixture; the agent host registers watches on it that
 * report nothing, since no directory is there to watch.
 */
const E2E_MOCK_PATH_PREFIX = path.normalize(`${path.resolve('/mock')}${path.sep}`);

/** A mounted root is presented as `path.normalize` spells it, so match that spelling. */
export function hasE2eMockPathPrefix(requestedPath: string): boolean {
  return path.normalize(requestedPath).startsWith(E2E_MOCK_PATH_PREFIX);
}
