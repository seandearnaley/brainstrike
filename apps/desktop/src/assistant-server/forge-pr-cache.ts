import type { ForgeCacheEntry, ForgeCachePort } from '@brainstrike/state-store';
import type { ForgePullRequest } from '@brainstrike/types';

/** Null means never observed; a stored entry with null PR is a durable observed absence. */
export async function readForgePrCacheEntry(
  store: ForgeCachePort,
  repoCommonDir: string,
  branch: string
): Promise<ForgeCacheEntry | null> {
  return (await store.forgeCache({ branch, operation: 'get', repoCommonDir })).entry;
}
export async function writeForgePrCacheEntry(
  store: ForgeCachePort,
  input: {
    readonly branch: string;
    readonly observedAt: string;
    readonly pullRequest: ForgePullRequest | null;
    readonly repoCommonDir: string;
  }
): Promise<void> {
  await store.forgeCache({ operation: 'write', ...input });
}
