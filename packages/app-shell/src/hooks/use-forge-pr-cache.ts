/**
 * The renderer-side mirror of `apps/desktop/src/assistant-server/forge-pr-cache.ts`'s
 * SELECT: a list-wide live query over `brainstrike_forge_prs`, projected into
 * a `(repoCommonDir, branch)` lookup the thread rows join against.
 *
 * `app-shell` cannot import `apps/desktop` (renderer/main boundary), so this
 * cannot reuse main's reader directly — but both sides CAN import
 * `@brainstrike/types`, which is where `readChecks`, `FORGE_CHECK_CONCLUSIONS`
 * (via `readChecks`) and `forgePrCacheKey` actually live. Importing them here
 * rather than re-declaring them is the point: a conclusion added to
 * `ForgeCheckConclusion` without updating a SECOND copy of the validator would
 * pass on one side and throw the entire projection on the other, and a NUL
 * key builder that drifted between the two sides would silently stop joining
 * rows the desktop cache wrote.
 *
 * THROW-DON'T-COERCE, same posture as main: `projectForgePrRows` fails the
 * WHOLE projection (empty map, `error` set) on a single malformed row rather
 * than rendering the other rows as if the bad one were simply absent — an
 * absent PR and an unreadable one must never look the same to the user.
 */
import { type DbHandle, makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import {
  type ForgePrCacheEntry,
  type ForgePrState,
  forgePrCacheKey,
  readChecks,
  rollupForgeChecks,
} from '@brainstrike/types';
import { useMemo } from 'react';

export const FORGE_PR_CACHE_SQL = `
  SELECT
    repo_common_dir AS "repoCommonDir",
    branch AS "branch",
    number AS "number",
    url AS "url",
    state AS "state",
    is_draft AS "isDraft",
    checks_json AS "checksJson"
  FROM brainstrike_forge_prs
  ORDER BY "repoCommonDir" ASC, "branch" ASC
`;

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
      const checks = readChecks(row['checksJson']);
      byRepoBranch.set(forgePrCacheKey(repoCommonDir, branch), {
        branch,
        checksRollup: rollupForgeChecks(checks),
        isDraft: row['isDraft'] === true,
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

export function useForgePrCache({
  database,
  enabled,
}: {
  readonly database: DbHandle | null;
  readonly enabled: boolean;
}): ForgePrCacheState {
  const liveQuery = usePGliteLiveQuery<Record<string, unknown>>({
    cacheKey: makeLiveQueryKey('forge-pr-cache'),
    clearOnDisable: true,
    enabled: database !== null && enabled,
    params: [],
    query: FORGE_PR_CACHE_SQL,
  });
  const projection = useMemo(() => projectForgePrRows(liveQuery.rows), [liveQuery.rows]);
  const error = liveQuery.error ?? projection.error;

  return {
    byRepoBranch: error ? EMPTY_FORGE_PR_CACHE : projection.byRepoBranch,
    error,
    loading: liveQuery.loading,
  };
}
