import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';

/**
 * Make `file` a genuine read fault for this user: mode bits on POSIX, where
 * Node's chmod cannot deny reads on Windows (it only toggles the read-only
 * attribute), and a deny-read-data entry for Everyone on Windows. Throws when
 * the file is still readable, so a fixture that cannot hold never passes as one.
 */
export function makeUnreadable(file: string): void {
  if (process.platform === 'win32') {
    execFileSync('icacls', [file, '/deny', '*S-1-1-0:(RD)'], { stdio: 'pipe' });
  } else {
    chmodSync(file, 0o000);
  }
  let readable = true;
  try {
    readFileSync(file);
  } catch {
    readable = false;
  }
  if (readable) {
    throw new Error(`${file} is still readable after denying reads.`);
  }
}
