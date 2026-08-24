/**
 * The three statements against `brainstrike_forge_prs` (migration 110).
 *
 * The table is created by the numbered/Drizzle migration runners, NEVER here —
 * this module only reads and writes, exactly like `run-persistence.ts` against
 * the renderer-bootstrapped run tables.
 *
 * `checks_json` round-trips the normalized `ForgeCheck[]`. PGlite may hand a
 * `jsonb` column back as a parsed value OR as its JSON text depending on the
 * transport in play (direct handle vs. db-host client); both are faithful
 * encodings of the SAME value, so `readChecks` accepts either. An unreadable
 * payload THROWS — a cache row we cannot interpret must not be rendered as a
 * PR with no checks.
 */
import type { ForgeCheck, ForgeCheckConclusion, ForgePullRequest } from '@brainstrike/types';
import { rollupForgeChecks } from '@brainstrike/types';

export const FORGE_PR_CACHE_TABLE = 'brainstrike_forge_prs';

/** Exactly the surface these statements need — satisfied by db-main's handle and a bare PGlite. */
export interface ForgeCacheDatabase {
  readonly query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

const SELECT_SQL = `
  SELECT
    number AS "number",
    url AS "url",
    title AS "title",
    state AS "state",
    is_draft AS "isDraft",
    review_decision AS "reviewDecision",
    checks_json AS "checksJson",
    head_sha AS "headSha",
    observed_at AS "observedAt"
  FROM ${FORGE_PR_CACHE_TABLE}
  WHERE repo_common_dir = $1 AND branch = $2
`;

const UPSERT_SQL = `
  INSERT INTO ${FORGE_PR_CACHE_TABLE} (
    repo_common_dir, branch, number, url, title, state,
    is_draft, review_decision, checks_json, head_sha, observed_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
  ON CONFLICT (repo_common_dir, branch) DO UPDATE SET
    number = EXCLUDED.number,
    url = EXCLUDED.url,
    title = EXCLUDED.title,
    state = EXCLUDED.state,
    is_draft = EXCLUDED.is_draft,
    review_decision = EXCLUDED.review_decision,
    checks_json = EXCLUDED.checks_json,
    head_sha = EXCLUDED.head_sha,
    observed_at = EXCLUDED.observed_at
`;

const DELETE_SQL = `DELETE FROM ${FORGE_PR_CACHE_TABLE} WHERE repo_common_dir = $1 AND branch = $2`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function readState(value: unknown): ForgePullRequest['state'] {
  if (value === 'open' || value === 'closed' || value === 'merged') {
    return value;
  }
  throw new Error(`Cached forge PR has unrecognized state "${String(value)}".`);
}

function readReviewDecision(value: unknown): ForgePullRequest['reviewDecision'] {
  if (value === null) {
    return null;
  }
  if (value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED') {
    return value;
  }
  // Like every other reader in this file: an unreadable column throws rather
  // than silently coercing to null, which would render a genuine (if
  // unrecognized) review decision as "no review yet".
  throw new Error(`Cached forge PR has an unrecognized review decision "${String(value)}".`);
}

function readObservedAt(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    return new Date(value).toISOString();
  }
  throw new Error('Cached forge PR has no observation timestamp.');
}

export async function readForgePrCacheEntry(
  db: ForgeCacheDatabase,
  repoCommonDir: string,
  branch: string
): Promise<{ readonly observedAt: string; readonly pullRequest: ForgePullRequest } | null> {
  const result = await db.query(SELECT_SQL, [repoCommonDir, branch]);
  const row = result.rows[0];
  if (!isRecord(row)) {
    return null;
  }
  const checks = readChecks(row['checksJson']);
  const number = Number(row['number']);
  if (!Number.isInteger(number)) {
    throw new Error('Cached forge PR has a non-integer number.');
  }
  return {
    observedAt: readObservedAt(row['observedAt']),
    pullRequest: {
      checks,
      checksRollup: rollupForgeChecks(checks),
      headSha: String(row['headSha']),
      isDraft: row['isDraft'] === true,
      number,
      reviewDecision: readReviewDecision(row['reviewDecision']),
      state: readState(row['state']),
      title: String(row['title']),
      url: String(row['url']),
    },
  };
}

export async function writeForgePrCacheEntry(
  db: ForgeCacheDatabase,
  input: {
    readonly branch: string;
    readonly observedAt: string;
    readonly pullRequest: ForgePullRequest;
    readonly repoCommonDir: string;
  }
): Promise<void> {
  const { branch, observedAt, pullRequest, repoCommonDir } = input;
  await db.query(UPSERT_SQL, [
    repoCommonDir,
    branch,
    pullRequest.number,
    pullRequest.url,
    pullRequest.title,
    pullRequest.state,
    pullRequest.isDraft,
    pullRequest.reviewDecision,
    JSON.stringify(pullRequest.checks),
    pullRequest.headSha,
    observedAt,
  ]);
}

/** Removes the row for a branch gh reports as having NO pull request. */
export async function deleteForgePrCacheEntry(
  db: ForgeCacheDatabase,
  repoCommonDir: string,
  branch: string
): Promise<void> {
  await db.query(DELETE_SQL, [repoCommonDir, branch]);
}
