import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];

/** A fresh directory under the OS temp dir, removed by `cleanupDirs()`. */
export function freshDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `bs-ss-${tag}-`));
  made.push(d);
  return d;
}

export function cleanupDirs(): void {
  for (const d of made.splice(0)) {
    rmSync(d, { force: true, recursive: true });
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });
