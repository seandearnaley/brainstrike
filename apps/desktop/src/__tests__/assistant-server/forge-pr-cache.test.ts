import type { ForgePullRequest } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  type ForgeCacheDatabase,
  readForgePrCacheEntry,
  writeForgePrCacheEntry,
} from '../../assistant-server/forge-pr-cache';

const REPO = '/repos/widgets/.git';
const BRANCH = 'feature/bar';

/** In-memory stand-in for `brainstrike_forge_prs`, keyed like the real PK. */
function fakeDatabase(): ForgeCacheDatabase & {
  readonly rows: Map<string, Record<string, unknown>>;
} {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const key = `${String(params[0])}\0${String(params[1])}`;
      if (sql.includes('SELECT')) {
        const row = rows.get(key);
        return { rows: row ? [row] : [] };
      }
      rows.set(key, {
        checksJson: params[8],
        headSha: params[9],
        isDraft: params[6],
        number: params[2],
        observedAt: params[10],
        reviewDecision: params[7],
        state: params[5],
        title: params[4],
        url: params[3],
      });
      return { rows: [] };
    },
    rows,
  };
}

const PULL_REQUEST: ForgePullRequest = {
  checks: [{ conclusion: 'success', name: 'unit', url: null }],
  checksRollup: 'passing',
  headSha: 'sha-1',
  isDraft: false,
  number: 42,
  reviewDecision: null,
  state: 'open',
  title: 'Widget it',
  url: 'https://github.com/acme/widgets/pull/42',
};

const OBSERVED_AT = '2026-08-24T00:00:00.000Z';

describe('readForgePrCacheEntry / writeForgePrCacheEntry — none-row shape (R1)', () => {
  it('returns null (never observed) when there is no row at all', async () => {
    const db = fakeDatabase();
    expect(await readForgePrCacheEntry(db, REPO, BRANCH)).toBeNull();
  });

  it('round-trips a durable observed-absence row with every PR column null', async () => {
    const db = fakeDatabase();
    await writeForgePrCacheEntry(db, {
      branch: BRANCH,
      observedAt: OBSERVED_AT,
      pullRequest: null,
      repoCommonDir: REPO,
    });
    const read = await readForgePrCacheEntry(db, REPO, BRANCH);
    expect(read).toEqual({ observedAt: OBSERVED_AT, pullRequest: null });
  });

  it('round-trips a PR row', async () => {
    const db = fakeDatabase();
    await writeForgePrCacheEntry(db, {
      branch: BRANCH,
      observedAt: OBSERVED_AT,
      pullRequest: PULL_REQUEST,
      repoCommonDir: REPO,
    });
    const read = await readForgePrCacheEntry(db, REPO, BRANCH);
    expect(read).toEqual({ observedAt: OBSERVED_AT, pullRequest: PULL_REQUEST });
  });

  it('upserting a none row over a PR row clears it to a none row (never a delete)', async () => {
    const db = fakeDatabase();
    await writeForgePrCacheEntry(db, {
      branch: BRANCH,
      observedAt: OBSERVED_AT,
      pullRequest: PULL_REQUEST,
      repoCommonDir: REPO,
    });
    await writeForgePrCacheEntry(db, {
      branch: BRANCH,
      observedAt: '2026-08-24T01:00:00.000Z',
      pullRequest: null,
      repoCommonDir: REPO,
    });
    expect(db.rows.size).toBe(1);
    const read = await readForgePrCacheEntry(db, REPO, BRANCH);
    expect(read).toEqual({ observedAt: '2026-08-24T01:00:00.000Z', pullRequest: null });
  });
});

describe('readForgePrCacheEntry — strict readers on a PR-claiming row (R4)', () => {
  const validRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    checksJson: '[]',
    headSha: 'sha-1',
    isDraft: false,
    number: 42,
    observedAt: OBSERVED_AT,
    reviewDecision: null,
    state: 'open',
    title: 'Widget it',
    url: 'https://github.com/acme/widgets/pull/42',
    ...overrides,
  });

  it('reads a fully-populated row cleanly', async () => {
    const db = fakeDatabase();
    db.rows.set(`${REPO}\0${BRANCH}`, validRow());
    const read = await readForgePrCacheEntry(db, REPO, BRANCH);
    expect(read?.pullRequest?.url).toBe('https://github.com/acme/widgets/pull/42');
    expect(read?.pullRequest?.headSha).toBe('sha-1');
    expect(read?.pullRequest?.title).toBe('Widget it');
  });

  it('throws on a null url instead of coercing to the literal string "null"', async () => {
    const db = fakeDatabase();
    db.rows.set(`${REPO}\0${BRANCH}`, validRow({ url: null }));
    await expect(readForgePrCacheEntry(db, REPO, BRANCH)).rejects.toThrow(/url/);
  });

  it('throws on a null head SHA instead of coercing to the literal string "null"', async () => {
    const db = fakeDatabase();
    db.rows.set(`${REPO}\0${BRANCH}`, validRow({ headSha: null }));
    await expect(readForgePrCacheEntry(db, REPO, BRANCH)).rejects.toThrow(/head SHA/);
  });

  it('throws on a non-string title instead of coercing it to text', async () => {
    const db = fakeDatabase();
    db.rows.set(`${REPO}\0${BRANCH}`, validRow({ title: 12_345 }));
    await expect(readForgePrCacheEntry(db, REPO, BRANCH)).rejects.toThrow(/title/);
  });

  it('accepts an empty-string title (legitimate, unlike an empty url or head SHA)', async () => {
    const db = fakeDatabase();
    db.rows.set(`${REPO}\0${BRANCH}`, validRow({ title: '' }));
    const read = await readForgePrCacheEntry(db, REPO, BRANCH);
    expect(read?.pullRequest?.title).toBe('');
  });
});
