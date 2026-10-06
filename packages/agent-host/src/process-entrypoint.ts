import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Node resolves ESM module paths even when argv names the same file through a symlink. */
export function isProcessEntrypoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
