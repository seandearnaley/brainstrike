import { type DbHandle, makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import {
  type ForgeCheck,
  type ForgeCheckConclusion,
  type ForgePrCacheEntry,
  type ForgePrState,
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
const FORGE_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set<ForgeCheckConclusion>([
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'pending',
  'skipped',
  'success',
  'timed_out',
]);

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

function readChecks(value: unknown): readonly ForgeCheck[] {
  const source = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(source)) {
    throw new Error('Cached forge checks are unreadable: the value is not an array.');
  }
  return source.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Cached forge check ${index} is not an object.`);
    }
    const conclusion = entry['conclusion'];
    const name = entry['name'];
    const url = entry['url'];
    if (typeof conclusion !== 'string' || !FORGE_CHECK_CONCLUSIONS.has(conclusion)) {
      throw new Error(`Cached forge check ${index} has an unrecognized conclusion.`);
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error(`Cached forge check ${index} has no name.`);
    }
    if (!(url === null || typeof url === 'string')) {
      throw new Error(`Cached forge check ${index} has an unreadable URL.`);
    }
    return { conclusion: conclusion as ForgeCheckConclusion, name, url };
  });
}

function readState(value: unknown): ForgePrState | null {
  return value === 'closed' || value === 'merged' || value === 'open' ? value : null;
}

export function forgePrCacheKey(gitCommonDir: string, branch: string): string {
  return `${gitCommonDir}\0${branch}`;
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
      if (typeof number !== 'number' || typeof url !== 'string' || state === null) {
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
