/**
 * The two statements against `brainstrike_forge_prs` (migration 110).
 *
 * The table is created by the numbered/Drizzle migration runners, NEVER here —
 * this module only reads and writes, exactly like `run-persistence.ts` against
 * the renderer-bootstrapped run tables.
 *
 * `checks_json` round-trips the normalized `ForgeCheck[]`. PGlite may hand a
 * `jsonb` column back as a parsed value OR as its JSON text depending on the
 * transport in play (direct handle vs. db-host client); both are faithful
 * encodings of the SAME value, so `readChecks` (shared with the renderer's
 * `use-forge-pr-cache.ts` via `@brainstrike/types`, so main and renderer can
 * never validate a cached checks list differently) accepts either. An
 * unreadable payload THROWS — a cache row we cannot interpret must not be
 * rendered as a PR with no checks.
 *
 * ROW SHAPE (BST-1391 round 2, review comment 3847743481): a row is EITHER a
 * PR observation (every PR-specific column populated) OR an observed-absence
 * ("none") observation (every PR-specific column NULL) — `readForgePrCacheEntry`
 * returns `{ observedAt, pullRequest: null }` for the latter, never `null`
 * itself; `null` means the key has NEVER been observed (no row at all). The
 * discriminant is `number`: the migration's CHECK constraint enforces the
 * all-or-nothing invariant, so a null `number` is sufficient to identify a
 * `none` row.
 *
 * `writeForgePrCacheEntry` accepts `pullRequest: null` for exactly this case
 * and upserts the all-NULL row — there is no separate delete path (review
 * comment 3847752917 folds the old "gh reports no PR ⇒ DELETE the row" path
 * into this upsert; a durable `none` observation is the point).
 *
 * Every reader below THROWS on a value it cannot interpret rather than
 * coercing (review comment 3847746120): a `null`/non-string `headSha`,
 * `title`, or `url` on a row that claims to carry a PR (non-null `number`) is
 * corruption, not a legitimate absence — `String(null)` silently becoming the
 * literal text `"null"` would render a clickable link to nowhere and a fake-
 * valid cache key. Nulls are ONLY legitimate on a `none` row, handled before
 * any of these readers run.
 */
import type { ForgePullRequest } from '@brainstrike/types';
import { readChecks, rollupForgeChecks } from '@brainstrike/types';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** Throws on anything but a non-empty string — never coerces `null`/`undefined` into text. */
function readNonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Cached forge PR has an unreadable ${label}.`);
  }
  return value;
}

/** Same discipline as `readNonEmptyText`, but an empty string is a legitimate title. */
function readText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Cached forge PR has an unreadable ${label}.`);
  }
  return value;
}

/**
 * `typeof value === 'number' && Number.isInteger(value)` — never `Number(value)`.
 * PGlite's client hands back a `number` for an `int4` column, so a value that
 * arrives as anything else (a numeric string, `NaN`, a float) is corruption,
 * not a legitimate PR number that merely needs coercing into shape.
 */
function readNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  throw new Error(`Cached forge PR has a non-integer number "${String(value)}".`);
}

export async function readForgePrCacheEntry(
  db: ForgeCacheDatabase,
  repoCommonDir: string,
  branch: string
): Promise<{ readonly observedAt: string; readonly pullRequest: ForgePullRequest | null } | null> {
  const result = await db.query(SELECT_SQL, [repoCommonDir, branch]);
  const row = result.rows[0];
  if (!isRecord(row)) {
    // No row at all: this key has never been observed, PR or absence alike.
    return null;
  }
  const observedAt = readObservedAt(row['observedAt']);
  if (row['number'] === null || row['number'] === undefined) {
    // A durable observed absence (R1): gh answered "no pull request" for this
    // branch. The migration's CHECK constraint guarantees every other
    // PR-specific column is NULL too, so there is nothing else to read.
    return { observedAt, pullRequest: null };
  }
  const checks = readChecks(row['checksJson']);
  const number = readNumber(row['number']);
  return {
    observedAt,
    pullRequest: {
      checks,
      checksRollup: rollupForgeChecks(checks),
      headSha: readNonEmptyText(row['headSha'], 'head SHA'),
      isDraft: row['isDraft'] === true,
      number,
      reviewDecision: readReviewDecision(row['reviewDecision']),
      state: readState(row['state']),
      title: readText(row['title'], 'title'),
      url: readNonEmptyText(row['url'], 'url'),
    },
  };
}

/**
 * Upserts either a PR observation or a durable "none" observation
 * (`pullRequest: null`) — there is no separate delete path. gh reporting NO
 * pull request for a branch is itself a durable fact worth the same
 * instant-boot rendering as a PR, so it gets the same row, with every
 * PR-specific column NULL (enforced by the migration's CHECK constraint).
 */
export async function writeForgePrCacheEntry(
  db: ForgeCacheDatabase,
  input: {
    readonly branch: string;
    readonly observedAt: string;
    readonly pullRequest: ForgePullRequest | null;
    readonly repoCommonDir: string;
  }
): Promise<void> {
  const { branch, observedAt, pullRequest, repoCommonDir } = input;
  await db.query(UPSERT_SQL, [
    repoCommonDir,
    branch,
    pullRequest?.number ?? null,
    pullRequest?.url ?? null,
    pullRequest?.title ?? null,
    pullRequest?.state ?? null,
    pullRequest?.isDraft ?? null,
    pullRequest?.reviewDecision ?? null,
    pullRequest ? JSON.stringify(pullRequest.checks) : null,
    pullRequest?.headSha ?? null,
    observedAt,
  ]);
}
