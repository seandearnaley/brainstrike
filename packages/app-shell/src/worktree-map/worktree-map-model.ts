/**
 * The Worktree Map's ONE projection (spec §10). Pure: no bridge, no DB, no
 * React. Everything it needs is already produced by a landed surface —
 * `worktrees.list()`, `useForgePrCache`, the assistant thread store,
 * `useActiveAssistantThreadIds`, and BST-1453's worktree indexing opt-ins — so
 * the Map introduces no new source of truth for any fact it renders.
 */
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type { ForgePrCacheEntry, WorktreeListEntry } from '@brainstrike/types';
import { forgePrCacheKey } from '@brainstrike/types';

export type ForgePrCacheLookup = ReadonlyMap<string, ForgePrCacheEntry>;

export interface WorktreeMapThread {
  readonly running: boolean;
  readonly threadId: string;
  readonly title: string;
  /**
   * `AssistantMemoryThread.updatedAt` is a `Date` (assistant-memory-repository
   * declares it so, and `assistant-thread-store`'s `serializeThread` re-wraps it
   * with `new Date(...)` on every load and merge). Typed as `Date` here so the
   * model can never silently render an object as "[object Object]".
   */
  readonly updatedAt: Date | null;
}

export interface WorktreeMapCardModel {
  readonly branchLabel: string;
  readonly createdAt: string | null;
  /** Non-null exactly when the entry is not usable — passed through verbatim. */
  readonly disabledReason: string | null;
  readonly entry: WorktreeListEntry;
  /**
   * `not-a-root` means the worktree is not mounted as a workspace root, so
   * there is no indexing preference to report. It is NOT "excluded": inventing
   * an answer for an unmounted path would be a silent fallback.
   */
  readonly indexing: 'excluded' | 'included' | 'not-a-root';
  readonly lastActivityLabel: string | null;
  readonly provenanceLabel: string;
  readonly pullRequest: ForgePrCacheEntry | null;
  readonly thread: WorktreeMapThread | null;
}

export interface WorktreeMapRepositoryModel {
  readonly cards: readonly WorktreeMapCardModel[];
  readonly repoCommonDir: string;
  readonly repositoryName: string;
  readonly repositoryRoot: string;
}

function displayNameFor(absolutePath: string): string {
  return absolutePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? absolutePath;
}

export function describeWorktreeProvenance(entry: WorktreeListEntry): string {
  if (entry.primary) {
    return 'Primary checkout';
  }
  if (entry.provenance === 'agent-reported') {
    return 'Missing on disk';
  }
  if (entry.externalTool === 'claude-code') {
    return 'Claude Code';
  }
  if (entry.externalTool === 'codex') {
    return 'Codex';
  }
  if (entry.externalTool === 'cursor') {
    return 'Cursor';
  }
  return entry.managed ? 'Managed' : 'External';
}

function branchLabelFor(entry: WorktreeListEntry): string {
  if (entry.branch) {
    return entry.branch;
  }
  return entry.detached ? 'detached HEAD' : 'no branch';
}

function indexingFor(
  entry: WorktreeListEntry,
  optInByRootId: Readonly<Record<string, true>>
): WorktreeMapCardModel['indexing'] {
  // (bot review fix, PR #2664 finding 1) `rootId` alone is NOT "this
  // checkout's own root" — it can be the first root that merely CONTAINS
  // this path (the primary checkout inside a larger open folder, or a
  // worktree nested inside another mounted root). Toggling indexing on that
  // containing root would silently mutate a DIFFERENT root's preference
  // while showing no effect on the checkout actually displayed. Only an
  // EXACT mount (`rootIdIsExactMount`) is index-toggleable; a
  // containing-only root renders the honest 'not-a-root' tri-state, same as
  // no root at all.
  if (entry.rootId === null || !entry.rootIdIsExactMount) {
    return 'not-a-root';
  }
  return optInByRootId[entry.rootId] === true ? 'included' : 'excluded';
}

function threadFor(
  entry: WorktreeListEntry,
  threadsByWorktreeId: ReadonlyMap<string, AssistantMemoryThread>,
  runningThreadIds: ReadonlySet<string>
): WorktreeMapThread | null {
  if (entry.id === null) {
    return null;
  }
  const thread = threadsByWorktreeId.get(entry.id);
  if (!thread) {
    return null;
  }
  return {
    running: runningThreadIds.has(thread.id),
    threadId: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt instanceof Date ? thread.updatedAt : null,
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Beyond a week, "last month" stops being informative — show the date instead. */
const RELATIVE_LIMIT_MS = 7 * DAY_MS;
const UNREADABLE_TIME = 'at an unreadable time';
// Module scope, not rebuilt per call (React Doctor): both formatters are
// stateless and locale-only — the `undefined` locale argument means "use the
// runtime's current locale" every time `.format()` runs, so hoisting them
// changes nothing about the rendered output, only how often they're
// constructed.
const ABSOLUTE_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
});
const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/**
 * A human "last activity", not a machine timestamp. `Intl` does the localizing,
 * so a non-English locale reads correctly without a translation table here.
 * `now` is a parameter rather than `Date.now()` so the unit lane is
 * deterministic without faking timers.
 */
export function formatWorktreeActivity(at: Date, now: Date): string {
  const elapsed = now.getTime() - at.getTime();
  if (!Number.isFinite(elapsed)) {
    // An unparseable stamp says so. `Intl` would render "Invalid Date", which
    // reads like a bug report in the middle of a card.
    return UNREADABLE_TIME;
  }
  const magnitude = Math.abs(elapsed);
  if (magnitude > RELATIVE_LIMIT_MS) {
    return ABSOLUTE_DATE_FORMAT.format(at);
  }
  // Bucket on MAGNITUDE, not on `elapsed`'s raw sign: a plain `elapsed <
  // MINUTE_MS` is also true for any FUTURE timestamp up to a week ahead
  // (clock skew, or a store that has not settled), which would render "just
  // now" for something that hasn't happened. But gating on `elapsed >= 0`
  // alone overcorrects — a 1ms future skew would then fall through to the
  // relative branches and render "in 1 minute" via `-Math.floor(elapsed /
  // MINUTE_MS)`, a 60,000x overstatement. Anything within a minute of now,
  // past OR future, is indistinguishable from "now" to a human; only once the
  // MAGNITUDE clears a full minute does relative tense ("in N
  // minutes/hours/days" via `Intl.RelativeTimeFormat`'s own sign handling)
  // become honest.
  if (magnitude < MINUTE_MS) {
    return 'just now';
  }
  // `Math.trunc`, not `Math.floor`: they agree for positive (past) `elapsed`,
  // but `floor` rounds a negative (future) `elapsed` AWAY from zero — 90s
  // future would read "in 2 minutes" while 90s past reads "1 minute ago".
  // `trunc` rounds toward zero either way, so the two stay symmetric.
  if (magnitude < HOUR_MS) {
    return RELATIVE_TIME_FORMAT.format(-Math.trunc(elapsed / MINUTE_MS), 'minute');
  }
  if (magnitude < DAY_MS) {
    return RELATIVE_TIME_FORMAT.format(-Math.trunc(elapsed / HOUR_MS), 'hour');
  }
  return RELATIVE_TIME_FORMAT.format(-Math.trunc(elapsed / DAY_MS), 'day');
}

function lastActivityLabelFor(
  thread: WorktreeMapThread | null,
  createdAt: string | null,
  format: (at: Date) => string
): string | null {
  if (thread?.updatedAt) {
    return `Active ${format(thread.updatedAt)}`;
  }
  if (createdAt) {
    // `WorktreeListEntry.createdAt` IS a string: it crosses the IPC boundary
    // from the ledger as JSON. Parsed exactly once, here, and a bad value is
    // stated rather than rendered as "Invalid Date".
    const parsed = new Date(createdAt);
    return `Created ${Number.isNaN(parsed.getTime()) ? UNREADABLE_TIME : format(parsed)}`;
  }
  // Neither fact exists. Rendering "unknown" would be noise; rendering an
  // invented timestamp would be a lie. Render nothing.
  return null;
}

/**
 * `AssistantMemoryThread.updatedAt` is typed as `Date`, but `threadFor` above
 * defends against a malformed one with `instanceof Date` (degrading to
 * `null`) rather than trusting the type — this comparator runs on the SAME
 * data and must agree, or a malformed `updatedAt` on a tying thread would
 * throw out of `.getTime()` here, inside `indexThreadsByWorktreeId`, before
 * `threadFor` ever gets the chance to degrade it gracefully. `null` means
 * "unreadable", never "epoch zero" — treating it as 0 would let a malformed
 * candidate look OLDER than every real thread instead of simply losing every
 * comparison, which changes today's answer with a bug that has nothing to do
 * with time.
 */
function preferredTimeOf(thread: AssistantMemoryThread): number | null {
  return thread.updatedAt instanceof Date ? thread.updatedAt.getTime() : null;
}

/**
 * `true` when `candidate` should occupy the worktree slot instead of
 * `existing`. Most-recently-updated wins; an exact `updatedAt` tie (same
 * millisecond) falls back to `id` ordering so the pick never depends on
 * `threads` array order — the store makes no ordering guarantee, and two
 * threads racing to claim one worktree is a real, user-visible scenario, not
 * a hypothetical. A malformed `updatedAt` never displaces a well-formed one,
 * and a well-formed one always displaces a malformed one — matching
 * `threadFor`'s degrade-to-null direction so a bad value can never win by
 * looking preferred.
 */
function isMorePreferredThread(
  candidate: AssistantMemoryThread,
  existing: AssistantMemoryThread
): boolean {
  const candidateTime = preferredTimeOf(candidate);
  const existingTime = preferredTimeOf(existing);
  if (candidateTime === null && existingTime === null) {
    return candidate.id < existing.id;
  }
  if (candidateTime === null) {
    return false;
  }
  if (existingTime === null) {
    return true;
  }
  if (candidateTime !== existingTime) {
    return candidateTime > existingTime;
  }
  return candidate.id < existing.id;
}

/**
 * Threads keyed by the worktree they are checked out into. A thread contributes
 * only when it is IN worktree mode: `checkoutWorktreeId` survives a hand-off to
 * Local in some legacy rows, and reading it without the mode check would show a
 * worktree as occupied by a thread that has already left it.
 */
function indexThreadsByWorktreeId(
  threads: readonly AssistantMemoryThread[]
): ReadonlyMap<string, AssistantMemoryThread> {
  const byWorktreeId = new Map<string, AssistantMemoryThread>();
  for (const thread of threads) {
    const metadata = thread.metadata;
    if (metadata?.checkoutMode !== 'worktree') {
      continue;
    }
    const worktreeId = metadata.checkoutWorktreeId;
    if (typeof worktreeId !== 'string' || worktreeId.length === 0) {
      continue;
    }
    const existing = byWorktreeId.get(worktreeId);
    if (!existing || isMorePreferredThread(thread, existing)) {
      byWorktreeId.set(worktreeId, thread);
    }
  }
  return byWorktreeId;
}

export function buildWorktreeMap(input: {
  readonly entries: readonly WorktreeListEntry[];
  /** Injectable for the unit lane; defaults to {@link formatWorktreeActivity}. */
  readonly formatActivity?: (at: Date) => string;
  readonly indexingOptInByRootId: Readonly<Record<string, true>>;
  readonly now?: Date;
  readonly prCache: ForgePrCacheLookup;
  readonly runningThreadIds: ReadonlySet<string>;
  readonly threads: readonly AssistantMemoryThread[];
}): readonly WorktreeMapRepositoryModel[] {
  const threadsByWorktreeId = indexThreadsByWorktreeId(input.threads);
  const now = input.now ?? new Date();
  const format = input.formatActivity ?? ((at: Date) => formatWorktreeActivity(at, now));
  const byRepository = new Map<
    string,
    { cards: WorktreeMapCardModel[]; entry: WorktreeListEntry }
  >();

  for (const entry of input.entries) {
    const thread = threadFor(entry, threadsByWorktreeId, input.runningThreadIds);
    const card: WorktreeMapCardModel = {
      branchLabel: branchLabelFor(entry),
      createdAt: entry.createdAt,
      disabledReason: entry.disabledReason,
      entry,
      indexing: indexingFor(entry, input.indexingOptInByRootId),
      lastActivityLabel: lastActivityLabelFor(thread, entry.createdAt, format),
      provenanceLabel: describeWorktreeProvenance(entry),
      pullRequest: entry.branch
        ? (input.prCache.get(forgePrCacheKey(entry.repoCommonDir, entry.branch)) ?? null)
        : null,
      thread,
    };
    const group = byRepository.get(entry.repoCommonDir);
    if (group) {
      group.cards.push(card);
      continue;
    }
    byRepository.set(entry.repoCommonDir, { cards: [card], entry });
  }

  return [...byRepository.values()]
    .map(({ cards, entry }) => ({
      // Primary first, then by name — the lane reads left-to-right as "the
      // user's clone, then the isolated copies" (spec §10).
      cards: [...cards].sort((left, right) => {
        if (left.entry.primary !== right.entry.primary) {
          return left.entry.primary ? -1 : 1;
        }
        return left.entry.name.localeCompare(right.entry.name);
      }),
      repoCommonDir: entry.repoCommonDir,
      repositoryName: displayNameFor(entry.repositoryRoot),
      repositoryRoot: entry.repositoryRoot,
    }))
    .sort((left, right) => left.repositoryName.localeCompare(right.repositoryName));
}
