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
  if (entry.rootId === null) {
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
  if (Math.abs(elapsed) > RELATIVE_LIMIT_MS) {
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(at);
  }
  if (elapsed < MINUTE_MS) {
    return 'just now';
  }
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (elapsed < HOUR_MS) {
    return relative.format(-Math.floor(elapsed / MINUTE_MS), 'minute');
  }
  if (elapsed < DAY_MS) {
    return relative.format(-Math.floor(elapsed / HOUR_MS), 'hour');
  }
  return relative.format(-Math.floor(elapsed / DAY_MS), 'day');
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
    byWorktreeId.set(worktreeId, thread);
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
