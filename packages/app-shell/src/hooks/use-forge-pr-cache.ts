import { type ForgePrCacheEntry, type ForgePrState, forgePrCacheKey } from '@brainstrike/types';
import { useEffect, useState } from 'react';
import { type ForgeBridge, resolveForgeBridge } from '../forge/forge-bridge';

const EMPTY_FORGE_PR_CACHE: ForgePrCacheLookup = new Map();

export type ForgePrCacheLookup = ReadonlyMap<string, ForgePrCacheEntry>;

export interface ForgePrCacheState {
  readonly byRepoBranch: ForgePrCacheLookup;
  readonly error: Error | null;
  readonly loading: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function readState(value: unknown): ForgePrState | null {
  return value === 'closed' || value === 'merged' || value === 'open' ? value : null;
}

export function projectForgePrRows(rows: readonly unknown[]): {
  readonly byRepoBranch: ForgePrCacheLookup;
  readonly error: Error | null;
} {
  const byRepoBranch = new Map<string, ForgePrCacheEntry>();
  try {
    for (const row of rows) {
      if (!isRecord(row)) {
        throw new Error('Forge PR cache query returned a non-object row.');
      }
      const branch = row['branch'];
      const repoCommonDir = row['repoCommonDir'];
      if (typeof repoCommonDir !== 'string' || typeof branch !== 'string') {
        throw new Error('Forge PR cache query returned an invalid repository or branch identity.');
      }
      const number = row['number'];
      if (number === null || number === undefined) {
        // Migration 110 defines this as the durable observation that gh found
        // no pull request. It is an honest absence, not a malformed PR row.
        continue;
      }
      const state = readState(row['state']);
      const url = row['url'];
      // typeof === 'number' + Number.isInteger, never Number(number): a
      // numeric string is corruption here, the same stricter posture
      // `forge-pr-cache.ts`'s `readNumber` enforces on main.
      if (
        typeof number !== 'number' ||
        !Number.isInteger(number) ||
        typeof url !== 'string' ||
        state === null
      ) {
        throw new Error('Forge PR cache query returned a malformed pull-request row.');
      }
      const checksRollup = row['checksRollup'];
      const isDraft = row['isDraft'];
      if (
        (checksRollup !== 'none' &&
          checksRollup !== 'passing' &&
          checksRollup !== 'failing' &&
          checksRollup !== 'pending') ||
        typeof isDraft !== 'boolean'
      ) {
        throw new Error(
          'Forge PR cache snapshot contains an unreadable checks rollup or draft state.'
        );
      }
      byRepoBranch.set(forgePrCacheKey(repoCommonDir, branch), {
        branch,
        checksRollup,
        isDraft,
        number,
        repoCommonDir,
        state,
        url,
      });
    }
  } catch (error: unknown) {
    return { byRepoBranch: new Map(), error: toError(error) };
  }
  return { byRepoBranch, error: null };
}

async function readCache(bridge: ForgeBridge): Promise<ForgePrCacheState> {
  try {
    const result = await bridge.cacheSnapshot();
    if (!result.ok) {
      throw new Error(result.error);
    }
    return { ...projectForgePrRows(result.value), loading: false };
  } catch (error) {
    return { byRepoBranch: EMPTY_FORGE_PR_CACHE, error: toError(error), loading: false };
  }
}

function subscribeForgeCache(
  bridge: ForgeBridge,
  publish: (state: ForgePrCacheState) => void
): () => void {
  let pending: Promise<unknown> | undefined;
  let disposed = false;
  const refresh = async (): Promise<void> => {
    const read = readCache(bridge);
    pending = read;
    const next = await read;
    if (!disposed && pending === read) {
      publish(next);
    }
  };
  const unsubscribe = bridge.onPrUpdated(() => {
    void refresh();
  });
  void refresh();
  return () => {
    disposed = true;
    unsubscribe();
  };
}

/** The existing Forge publisher invalidates this projection; web omits the capability. */
export function useForgePrCache({ enabled }: { readonly enabled: boolean }): ForgePrCacheState {
  const bridge = enabled ? resolveForgeBridge() : null;
  const [state, setState] = useState<ForgePrCacheState>({
    byRepoBranch: EMPTY_FORGE_PR_CACHE,
    error: null,
    loading: true,
  });
  useEffect(() => (bridge ? subscribeForgeCache(bridge, setState) : undefined), [bridge]);
  return bridge ? state : { byRepoBranch: EMPTY_FORGE_PR_CACHE, error: null, loading: false };
}
