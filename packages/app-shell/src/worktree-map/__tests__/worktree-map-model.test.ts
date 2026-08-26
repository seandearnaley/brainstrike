import type { AssistantMemoryThread, AssistantThreadMetadata } from '@brainstrike/assistant-data';
import type { WorktreeListEntry } from '@brainstrike/types';
import { forgePrCacheKey } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
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

  it('reports indexing state only for a mounted root, never guessing for an unmounted worktree', () => {
    const model = buildWorktreeMap({
      entries: [
        entry({ id: 'a', managed: true, path: '/a', primary: false, rootId: 'root-a' }),
        entry({ id: 'b', managed: true, path: '/b', primary: false, rootId: 'root-b' }),
        entry({ id: 'c', managed: true, path: '/c', primary: false, rootId: null }),
      ],
      indexingOptInByRootId: { 'root-a': true },
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model[0]?.cards.map((card) => card.indexing)).toEqual([
      'included',
      'excluded',
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
});
