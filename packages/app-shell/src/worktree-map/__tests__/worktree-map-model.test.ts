// @vitest-environment node
import type { AssistantMemoryThread, AssistantThreadMetadata } from '@brainstrike/assistant-data';
import type { WorktreeListEntry } from '@brainstrike/types';
import { forgePrCacheKey } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { selectWorktreeCollection } from '../worktree-map-collection';
import {
  buildWorktreeMap,
  describeWorktreeProvenance,
  formatWorktreeActivity,
} from '../worktree-map-model';

const NOW = new Date('2026-08-26T12:00:00.000Z');

// A REAL AssistantMemoryThread — every required field, correctly typed. The
// `as never` shortcut this file used to take made the Date-vs-string defect in
// `updatedAt` invisible: a cast fixture agrees with whatever the model claims.
function thread(overrides: {
  readonly id: string;
  readonly metadata?: AssistantThreadMetadata;
  readonly title?: string;
  readonly updatedAt?: Date;
}): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    id: overrides.id,
    resourceId: 'brainstrike:workspace',
    title: overrides.title ?? 'Untitled thread',
    updatedAt: overrides.updatedAt ?? NOW,
    ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  };
}

function entry(overrides: Partial<WorktreeListEntry> = {}): WorktreeListEntry {
  return {
    branch: 'main',
    containment: ['root-1'],
    createdAt: null,
    detached: false,
    disabledReason: null,
    externalTool: null,
    id: null,
    lockedReason: null,
    managed: false,
    name: 'brainstrike',
    path: '/repo',
    primary: true,
    provenance: 'scanned',
    remedy: null,
    repoCommonDir: '/repo/.git',
    repositoryRoot: '/repo',
    rootId: 'root-1',
    rootIdIsExactMount: true,
    setupReason: null,
    setupStatus: 'none',
    trust: 'validated',
    trustReason: null,
    usable: false,
    ...overrides,
  };
}

describe('buildWorktreeMap', () => {
  it('groups by repository and puts the primary checkout first in the lane', () => {
    const model = buildWorktreeMap({
      entries: [
        entry({ id: 'wt-1', managed: true, name: 'bright-fox', path: '/wt', primary: false }),
        entry(),
      ],
      indexingOptInByRootId: {},
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model).toHaveLength(1);
    expect(model[0]?.repositoryName).toBe('repo');
    expect(model[0]?.cards.map((card) => card.entry.path)).toEqual(['/repo', '/wt']);
  });

  it('keeps repositories separate and sorts them by display name', () => {
    const model = buildWorktreeMap({
      entries: [
        entry({ repoCommonDir: '/z/.git', repositoryRoot: '/z' }),
        entry({ repoCommonDir: '/a/.git', repositoryRoot: '/a' }),
      ],
      indexingOptInByRootId: {},
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model.map((repository) => repository.repositoryName)).toEqual(['a', 'z']);
  });

  it('joins the PR cache on (repoCommonDir, branch), not on repositoryRoot', () => {
    const pr = {
      branch: 'bs/bright-fox',
      checksRollup: 'passing' as const,
      isDraft: false,
      number: 2574,
      repoCommonDir: '/repo/.git',
      state: 'open' as const,
      url: 'https://github.com/acme/repo/pull/2574',
    };
    const model = buildWorktreeMap({
      entries: [entry({ branch: 'bs/bright-fox', path: '/wt', primary: false })],
      indexingOptInByRootId: {},
      prCache: new Map([[forgePrCacheKey('/repo/.git', 'bs/bright-fox'), pr]]),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model[0]?.cards[0]?.pullRequest).toEqual(pr);
  });

  it('attaches the thread whose checkout metadata names the worktree, with its run state', () => {
    const updatedAt = new Date('2026-08-26T10:00:00.000Z');
    const model = buildWorktreeMap({
      entries: [entry({ id: 'wt-1', managed: true, path: '/wt', primary: false })],
      indexingOptInByRootId: {},
      now: NOW,
      prCache: new Map(),
      runningThreadIds: new Set(['thread-1']),
      threads: [
        thread({
          id: 'thread-1',
          metadata: { checkoutMode: 'worktree', checkoutWorktreeId: 'wt-1' },
          title: 'Fix the parser',
          updatedAt,
        }),
        thread({
          id: 'thread-2',
          metadata: { checkoutMode: 'local' },
          title: 'Something else',
          updatedAt: new Date('2026-08-26T11:00:00.000Z'),
        }),
      ],
    });

    expect(model[0]?.cards[0]?.thread).toEqual({
      running: true,
      threadId: 'thread-1',
      title: 'Fix the parser',
      updatedAt,
    });
    // A `Date`, not a string — this is the assertion the old `as never` fixture
    // could not make, because a cast fixture agrees with any claim.
    expect(model[0]?.cards[0]?.thread?.updatedAt).toBeInstanceOf(Date);
    expect(model[0]?.cards[0]?.lastActivityLabel).toBe('Active 2 hours ago');
  });

  it('ignores a thread whose metadata names the worktree but has left worktree mode', () => {
    const model = buildWorktreeMap({
      entries: [entry({ id: 'wt-1', managed: true, path: '/wt', primary: false })],
      indexingOptInByRootId: {},
      now: NOW,
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [
        thread({
          id: 'thread-1',
          // Legacy shape: the worktree id survives a hand-off to Local.
          metadata: { checkoutMode: 'local', checkoutWorktreeId: 'wt-1' },
          title: 'Handed off already',
        }),
      ],
    });

    expect(model[0]?.cards[0]?.thread).toBeNull();
  });

  it('picks the most-recently-updated thread when two threads claim one worktree, regardless of array order', () => {
    const older = thread({
      id: 'thread-old',
      metadata: { checkoutMode: 'worktree', checkoutWorktreeId: 'wt-1' },
      title: 'Older',
      updatedAt: new Date('2026-08-26T09:00:00.000Z'),
    });
    const newer = thread({
      id: 'thread-new',
      metadata: { checkoutMode: 'worktree', checkoutWorktreeId: 'wt-1' },
      title: 'Newer',
      updatedAt: new Date('2026-08-26T10:00:00.000Z'),
    });
    const buildFor = (threads: readonly AssistantMemoryThread[]) =>
      buildWorktreeMap({
        entries: [entry({ id: 'wt-1', managed: true, path: '/wt', primary: false })],
        indexingOptInByRootId: {},
        now: NOW,
        prCache: new Map(),
        runningThreadIds: new Set(),
        threads,
      });

    expect(buildFor([older, newer])[0]?.cards[0]?.thread?.threadId).toBe('thread-new');
    expect(buildFor([newer, older])[0]?.cards[0]?.thread?.threadId).toBe('thread-new');
  });

  it('breaks an exact updatedAt tie by thread id, independent of array order', () => {
    const sameInstant = new Date('2026-08-26T10:00:00.000Z');
    const a = thread({
      id: 'thread-a',
      metadata: { checkoutMode: 'worktree', checkoutWorktreeId: 'wt-1' },
      updatedAt: sameInstant,
    });
    const b = thread({
      id: 'thread-b',
      metadata: { checkoutMode: 'worktree', checkoutWorktreeId: 'wt-1' },
      updatedAt: sameInstant,
    });
    const buildFor = (threads: readonly AssistantMemoryThread[]) =>
      buildWorktreeMap({
        entries: [entry({ id: 'wt-1', managed: true, path: '/wt', primary: false })],
        indexingOptInByRootId: {},
        now: NOW,
        prCache: new Map(),
        runningThreadIds: new Set(),
        threads,
      });

    expect(buildFor([a, b])[0]?.cards[0]?.thread?.threadId).toBe('thread-a');
    expect(buildFor([b, a])[0]?.cards[0]?.thread?.threadId).toBe('thread-a');
  });

  it('never throws on a malformed updatedAt and always prefers the well-formed thread, regardless of array order', () => {
    // `updatedAt` is TYPED as `Date`, but `threadFor` defends against a
    // malformed one at runtime (degrading to `null`) rather than trusting
    // the type — this deliberately violates that type to prove
    // `isMorePreferredThread` degrades the same direction instead of
    // throwing out of `.getTime()`.
    const malformed: AssistantMemoryThread = {
      ...thread({
        id: 'thread-bad',
        metadata: { checkoutMode: 'worktree', checkoutWorktreeId: 'wt-1' },
      }),
      updatedAt: 'not-a-date' as unknown as Date,
    };
    const wellFormed = thread({
      id: 'thread-good',
      metadata: { checkoutMode: 'worktree', checkoutWorktreeId: 'wt-1' },
      updatedAt: new Date('2026-08-26T10:00:00.000Z'),
    });
    const buildFor = (threads: readonly AssistantMemoryThread[]) =>
      buildWorktreeMap({
        entries: [entry({ id: 'wt-1', managed: true, path: '/wt', primary: false })],
        indexingOptInByRootId: {},
        now: NOW,
        prCache: new Map(),
        runningThreadIds: new Set(),
        threads,
      });

    expect(() => buildFor([malformed, wellFormed])).not.toThrow();
    expect(() => buildFor([wellFormed, malformed])).not.toThrow();
    expect(buildFor([malformed, wellFormed])[0]?.cards[0]?.thread?.threadId).toBe('thread-good');
    expect(buildFor([wellFormed, malformed])[0]?.cards[0]?.thread?.threadId).toBe('thread-good');
  });

  it('falls back to the ledger creation stamp, and renders nothing when neither fact exists', () => {
    const model = buildWorktreeMap({
      entries: [
        entry({ createdAt: '2026-08-20T00:00:00.000Z', id: 'a', path: '/a', primary: false }),
        entry({ createdAt: null, path: '/b', primary: false }),
      ],
      indexingOptInByRootId: {},
      now: NOW,
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model[0]?.cards[0]?.lastActivityLabel).toBe('Created 6 days ago');
    expect(model[0]?.cards[1]?.lastActivityLabel).toBeNull();
  });

  it('states an unparseable ledger stamp instead of rendering "Invalid Date"', () => {
    const model = buildWorktreeMap({
      entries: [entry({ createdAt: 'not-a-date', id: 'a', path: '/a', primary: false })],
      indexingOptInByRootId: {},
      now: NOW,
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model[0]?.cards[0]?.lastActivityLabel).toBe('Created at an unreadable time');
  });

  it('reports indexing state only for an EXACT root mount, never a containing-only one, and never guessing for an unmounted worktree', () => {
    // (bot review fix, PR #2664 finding 1) `rootId: 'root-d'` alone must NOT
    // be enough to toggle indexing: `rootIdIsExactMount: false` means this
    // root only CONTAINS the checkout (the primary inside a larger open
    // folder, or a worktree nested inside another mounted root), never that
    // it IS this checkout's own root. `indexingOptInByRootId` deliberately
    // carries a `true` entry for 'root-d' too, so this only passes if the
    // model actually gates on the flag — an absent opt-in would pass by
    // accident.
    const model = buildWorktreeMap({
      entries: [
        entry({ id: 'a', managed: true, path: '/a', primary: false, rootId: 'root-a' }),
        entry({ id: 'b', managed: true, path: '/b', primary: false, rootId: 'root-b' }),
        entry({ id: 'c', managed: true, path: '/c', primary: false, rootId: null }),
        entry({
          id: 'd',
          managed: true,
          path: '/d',
          primary: false,
          rootId: 'root-d',
          rootIdIsExactMount: false,
        }),
      ],
      indexingOptInByRootId: { 'root-a': true, 'root-d': true },
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model[0]?.cards.map((card) => card.indexing)).toEqual([
      'included',
      'excluded',
      'not-a-root',
      'not-a-root',
    ]);
  });

  it('carries the disabled reason through untouched', () => {
    const model = buildWorktreeMap({
      entries: [entry({ disabledReason: 'Locked: rebase in progress', usable: false })],
      indexingOptInByRootId: {},
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model[0]?.cards[0]?.disabledReason).toBe('Locked: rebase in progress');
  });
});

describe('describeWorktreeProvenance', () => {
  // `primary: false` overrides the fixture default so each case exercises the
  // externalTool/managed branch it names, not the primary short-circuit —
  // see the dedicated precedence test below for that.
  it.each([
    [{ externalTool: 'claude-code' as const, managed: false, primary: false }, 'Claude Code'],
    [{ externalTool: 'codex' as const, managed: false, primary: false }, 'Codex'],
    [{ externalTool: 'cursor' as const, managed: false, primary: false }, 'Cursor'],
    [{ externalTool: null, managed: true, primary: false }, 'Managed'],
    [{ externalTool: null, managed: false, primary: false }, 'External'],
  ])('labels %o as %s', (overrides, expected) => {
    expect(describeWorktreeProvenance(entry(overrides))).toBe(expected);
  });

  it('labels the primary checkout as the primary, ahead of every other label', () => {
    expect(describeWorktreeProvenance(entry({ managed: true, primary: true }))).toBe(
      'Primary checkout'
    );
  });

  it('labels the primary checkout as the primary even when an externalTool is set', () => {
    expect(describeWorktreeProvenance(entry({ externalTool: 'claude-code', primary: true }))).toBe(
      'Primary checkout'
    );
  });

  it('labels a ledger row missing on disk as agent-reported', () => {
    expect(
      describeWorktreeProvenance(
        entry({ managed: true, primary: false, provenance: 'agent-reported' })
      )
    ).toBe('Missing on disk');
  });
});

describe('formatWorktreeActivity', () => {
  it.each([
    [new Date('2026-08-26T11:59:30.000Z'), 'just now'],
    [new Date('2026-08-26T11:48:00.000Z'), '12 minutes ago'],
    [new Date('2026-08-26T09:00:00.000Z'), '3 hours ago'],
    [new Date('2026-08-23T12:00:00.000Z'), '3 days ago'],
  ])('renders %s as %s', (at, expected) => {
    expect(formatWorktreeActivity(at, NOW)).toBe(expected);
  });

  it('falls back to an absolute date beyond a week', () => {
    // Relative phrasing stops being informative once it is "last month"; the
    // absolute date is shorter to read and unambiguous.
    expect(formatWorktreeActivity(new Date('2026-06-01T12:00:00.000Z'), NOW)).toMatch(
      /Jun(?:e)? 1/u
    );
  });

  it('never renders "Invalid Date" for an unreadable input', () => {
    expect(formatWorktreeActivity(new Date(Number.NaN), NOW)).toBe('at an unreadable time');
  });

  it('treats a sub-minute future timestamp as "just now", not an overstated relative count', () => {
    // 1ms of clock skew must not render as "in 1 minute" — a 60,000x
    // overstatement that a plain `elapsed >= 0` gate would produce. Anything
    // within a minute of now, past OR future, reads as "now" to a human.
    expect(formatWorktreeActivity(new Date('2026-08-26T12:00:00.001Z'), NOW)).toBe('just now');
    expect(formatWorktreeActivity(new Date('2026-08-26T12:00:30.000Z'), NOW)).toBe('just now');
  });

  it('renders honest future tense once a future timestamp is a full minute or more ahead', () => {
    // Proves the magnitude clamp above does not swallow a GENUINELY future
    // timestamp — a week-ahead stamp must not silently read as "just now"
    // either (the original bug this guard exists for).
    expect(formatWorktreeActivity(new Date('2026-08-26T12:01:30.000Z'), NOW)).toBe('in 1 minute');
  });

  it('rounds a future timestamp toward zero the same way it rounds a past one', () => {
    // `Math.floor` rounds a negative (future) elapsed AWAY from zero, which
    // would make 90s future read "in 2 minutes" while 90s past reads
    // "1 minute ago" — an asymmetric rounding rule for the same magnitude.
    expect(formatWorktreeActivity(new Date('2026-08-26T12:01:30.000Z'), NOW)).toBe('in 1 minute');
    expect(formatWorktreeActivity(new Date('2026-08-26T11:58:30.000Z'), NOW)).toBe('1 minute ago');
  });
});

describe('worktree collection navigation', () => {
  const project = (entries: readonly WorktreeListEntry[]) =>
    buildWorktreeMap({
      entries,
      indexingOptInByRootId: {},
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });
  it('paginates across repository boundaries and clamps after a collection shrinks', () => {
    const repositories = project(
      Array.from({ length: 60 }, (_, i) =>
        entry({
          name: `wt-${i}`,
          path: `/wt/${i}`,
          primary: false,
          repoCommonDir: i < 30 ? '/a/.git' : '/b/.git',
          repositoryRoot: i < 30 ? '/a' : '/b',
        })
      )
    );
    const input = {
      filter: 'all' as const,
      page: 1,
      query: '',
      repositories,
      sort: 'name' as const,
      statusByPath: new Map(),
    };
    const result = selectWorktreeCollection(input);
    expect(result.repositories.map((repo) => repo.cards.length)).toEqual([5, 20]);
    expect(result.matched).toBe(60);
    const shrunk = selectWorktreeCollection({ ...input, page: 2, query: 'wt-59' });
    expect(shrunk.page).toBe(0);
    expect(shrunk.repositories[0]?.cards[0]?.entry.path).toBe('/wt/59');
  });
  it('keeps primary first, sorts activity newest first, and places missing dates last', () => {
    const repositories = project([
      entry({ name: 'primary', path: '/primary' }),
      entry({ createdAt: '2026-08-01T00:00:00Z', name: 'alpha', path: '/old', primary: false }),
      entry({ createdAt: '2026-09-01T00:00:00Z', name: 'zulu', path: '/new', primary: false }),
      entry({ name: 'undated', path: '/undated', primary: false }),
    ]);
    const result = selectWorktreeCollection({
      filter: 'all',
      page: 0,
      query: '',
      repositories,
      sort: 'recent',
      statusByPath: new Map(),
    });
    expect(result.repositories[0]?.cards.map((card) => card.entry.path)).toEqual([
      '/primary',
      '/new',
      '/old',
      '/undated',
    ]);
  });
  it('sorts linked thread activity ahead of checkout creation time', () => {
    const repositories = buildWorktreeMap({
      entries: [
        entry({
          createdAt: '2026-01-01T00:00:00Z',
          id: 'active',
          name: 'zulu',
          path: '/active',
          primary: false,
        }),
        entry({
          createdAt: '2026-08-01T00:00:00Z',
          name: 'alpha',
          path: '/new',
          primary: false,
        }),
      ],
      indexingOptInByRootId: {},
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [
        thread({
          id: 'thread-active',
          metadata: { checkoutMode: 'worktree', checkoutWorktreeId: 'active' },
          updatedAt: new Date('2026-09-01T00:00:00Z'),
        }),
      ],
    });
    const result = selectWorktreeCollection({
      filter: 'all',
      page: 0,
      query: '',
      repositories,
      sort: 'recent',
      statusByPath: new Map(),
    });
    expect(result.repositories[0]?.cards.map((card) => card.entry.path)).toEqual([
      '/active',
      '/new',
    ]);
  });
  it('external excludes the primary checkout and managed checkouts', () => {
    const repositories = project([
      entry(),
      entry({ path: '/external', primary: false }),
      entry({ managed: true, path: '/managed', primary: false }),
    ]);
    const result = selectWorktreeCollection({
      filter: 'external',
      page: 0,
      query: '',
      repositories,
      sort: 'name',
      statusByPath: new Map(),
    });
    expect(result.repositories[0]?.cards.map((card) => card.entry.path)).toEqual(['/external']);
  });
});
