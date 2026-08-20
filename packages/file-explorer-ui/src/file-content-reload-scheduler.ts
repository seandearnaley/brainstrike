import { createLogger } from '@brainstrike/logging';
import type { FileContentLoadIntent } from './file-content-load-authority-context';
import { settleFileContentPromises } from './file-content-load-results';

const logger = createLogger('FileContentReloadScheduler');

interface RunFileContentReloadGroupsParams {
  readonly clearGeneration: (compositeKey: string, expectedGeneration: number | undefined) => void;
  readonly compositeKeys: readonly string[];
  readonly getActiveLoad: (compositeKey: string) => Promise<void> | undefined;
  readonly intent: FileContentLoadIntent;
  readonly isCurrentGeneration: (compositeKey: string, expectedGeneration: number) => boolean;
  readonly reload: (
    compositeKeys: readonly string[],
    intent: FileContentLoadIntent
  ) => Promise<void>;
  readonly requestedGenerations: ReadonlyMap<string, number>;
}

/**
 * Runs one immediate reload batch plus one batch per distinct preceding read.
 * Dependency groups are independent: a slow or rejected predecessor cannot
 * starve keys that are ready or waiting on a different promise.
 */
export async function runFileContentReloadGroups({
  clearGeneration,
  compositeKeys,
  getActiveLoad,
  intent,
  isCurrentGeneration,
  reload,
  requestedGenerations,
}: RunFileContentReloadGroupsParams): Promise<void> {
  const immediatelyReadyKeys: string[] = [];
  const dependentKeyGroups = new Map<Promise<void>, string[]>();
  for (const key of compositeKeys) {
    const precedingLoad = getActiveLoad(key);
    if (!precedingLoad) {
      immediatelyReadyKeys.push(key);
      continue;
    }
    const group = dependentKeyGroups.get(precedingLoad);
    if (group) {
      group.push(key);
    } else {
      dependentKeyGroups.set(precedingLoad, [key]);
    }
  }

  const reloadGroup = async (
    keys: readonly string[],
    precedingLoad?: Promise<void>
  ): Promise<void> => {
    try {
      if (precedingLoad) {
        try {
          await precedingLoad;
        } catch {
          // The invalidated read cannot be used regardless of why it failed.
          // Diagnose by count only, then perform this group's fresh read.
          logger.warn('Preceding file-content read rejected before refresh retry', {
            fileCount: keys.length,
          });
        }
      }

      const currentKeys = keys.filter((key) => {
        const requestedGeneration = requestedGenerations.get(key);
        return requestedGeneration !== undefined && isCurrentGeneration(key, requestedGeneration);
      });
      if (currentKeys.length === 0) {
        return;
      }
      await reload(currentKeys, intent);
    } finally {
      // Clean this group as soon as its replacement settles. Another group's
      // slow/hung predecessor must not retain completed generations.
      for (const key of keys) {
        clearGeneration(key, requestedGenerations.get(key));
      }
    }
  };

  const reloads: Promise<void>[] = [];
  if (immediatelyReadyKeys.length > 0) {
    reloads.push(reloadGroup(immediatelyReadyKeys));
  }
  for (const [precedingLoad, keys] of dependentKeyGroups) {
    reloads.push(reloadGroup(keys, precedingLoad));
  }
  await settleFileContentPromises(reloads);
}
