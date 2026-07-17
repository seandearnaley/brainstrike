/**
 * Project-hook trust hashing primitives (desktop / main-process authority).
 *
 * Trust is pinned to the SHA-256 of the hooks file's RAW BYTES. Both the
 * renderer's approve-time review (`ipc-hooks-handlers.ts`) and the server's
 * load-time trust check (`config.ts` `loadHooksConfig`) hash the same raw
 * bytes through `sha256OfBuffer`, so a file with BOM/non-utf8 bytes hashes
 * identically on both sides — an approval always "takes". Never hash a
 * utf8-DECODED string: lossy decoding would diverge the two hashes and an
 * approved root's hooks would silently never run.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function sha256OfBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256OfFile(absPath: string): string | null {
  try {
    return sha256OfBuffer(readFileSync(absPath));
  } catch {
    // Missing/unreadable file is not an error here — it means "no trust".
    return null;
  }
}
