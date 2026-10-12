import { renameSync } from 'node:fs';
import { createRequire } from 'node:module';

type ReplacementAddon = Pick<typeof import('@brainstrike/secure-fs-native'), 'replaceFileSync'>;
let addon: ReplacementAddon | undefined;

export function replaceLockFileSync(source: string, target: string): void {
  if (process.platform !== 'win32') {
    renameSync(source, target);
    return;
  }
  addon ??= createRequire(import.meta.url)('@brainstrike/secure-fs-native') as ReplacementAddon;
  addon.replaceFileSync(source, target);
}
