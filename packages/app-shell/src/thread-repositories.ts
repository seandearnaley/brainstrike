/**
 * Which repository a thread works in, for the Threads panel's folder grouping
 * (ADR-0034 decision 1 and its owner decisions of 2026-11-10): a repository's
 * own checkout and its managed worktrees are its checkouts, so their threads
 * share one section, the section of the project its own checkout's folder
 * belongs to.
 *
 * Pure. The one input that knows about git is the host's worktree listing
 * (`worktrees.list()`), which already joins git's worktree list with the
 * host's worktree ledger and names each entry's repository by its git common
 * dir. Nothing here matches a folder to a repository by path.
 *
 * A worktree counts only while both records agree, the rule
 * `hostAnsweringFolder` applies on the host (`packages/agent-host/src/answering-folder.ts`):
 * the ledger lists it (`managed`) and git's two links join it to that
 * repository (`trust: 'validated'`). A worktree the person made and opened as
 * a folder, one whose links point elsewhere, and a ledger row with nothing on
 * disk each stay a folder of their own.
 */
import {
  type AssistantMemoryThread,
  getThreadPrimaryRootId,
  type ThreadFolderGroupingRow,
  type ThreadRepositoryRow,
} from '@brainstrike/assistant-data';
import type { WorktreeListEntry } from '@brainstrike/types';

export interface ThreadRepositoryLookup {
  /** Keyed by the `roots.id` of a folder that IS one of the repository's checkouts. */
  readonly byRootId: ReadonlyMap<string, ThreadRepositoryRow>;
  /** Keyed by the worktree ledger id a thread's binding names (`checkoutWorktreeId`). */
  readonly byWorktreeId: ReadonlyMap<string, ThreadRepositoryRow>;
}

/** Stable identity for "no thread works in a repository", so the panel's memo deps do not churn. */
const NO_REPOSITORY_BY_THREAD_ID: ReadonlyMap<string, ThreadRepositoryRow> = new Map();

/**
 * The repository a listing entry is a checkout of: its realpath'd git common
 * dir, as the worktree ledger keys it. A repository's section is keyed on its
 * project instead whenever its own checkout is a folder with one (see
 * `ThreadRepositoryRow.projectId`).
 */
function repositoryKey(entry: WorktreeListEntry): string {
  return entry.repoCommonDir;
}

function folderNameOf(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

/** The repository's own checkout as an open folder: an exact mount, never a folder that only contains it. */
function ownFolderRootId(checkout: WorktreeListEntry | undefined): string | null {
  return checkout?.rootIdIsExactMount ? checkout.rootId : null;
}

function repositoryRow(
  entries: readonly WorktreeListEntry[],
  folderRowsByRootId: ReadonlyMap<string, ThreadFolderGroupingRow>
): ThreadRepositoryRow | undefined {
  const [first] = entries;
  if (first === undefined) {
    return;
  }
  const ownCheckout = entries.find((entry) => entry.primary);
  const rootId = ownFolderRootId(ownCheckout);
  // The folder row comes from `roots`, the one source of a folder's name, path
  // and project; while it has not resolved the section offers no "new thread
  // here" and names no project.
  const folder = rootId === null ? null : (folderRowsByRootId.get(rootId) ?? null);
  return {
    branch: ownCheckout?.branch ?? null,
    detached: ownCheckout?.detached ?? false,
    displayName: folder?.displayName ?? folderNameOf(first.repositoryRoot),
    folder,
    key: repositoryKey(first),
    path: first.repositoryRoot,
    projectId: folder?.projectId ?? null,
    projectName: folder?.projectName ?? null,
  };
}

/** Whether `entry` is one of its repository's checkouts: the own checkout, or a managed worktree git still joins. */
function isRepositoryCheckout(entry: WorktreeListEntry): boolean {
  return entry.primary || (entry.managed && entry.trust === 'validated');
}

/**
 * The repositories a listing names, addressable the two ways a thread's
 * binding names where it works: its folder's root id, and the ledger id of the
 * worktree it is checked out into.
 */
export function projectThreadRepositories(
  entries: readonly WorktreeListEntry[],
  folderRowsByRootId: ReadonlyMap<string, ThreadFolderGroupingRow>
): ThreadRepositoryLookup {
  const entriesByRepositoryKey = new Map<string, WorktreeListEntry[]>();
  for (const entry of entries) {
    const key = repositoryKey(entry);
    const repositoryEntries = entriesByRepositoryKey.get(key);
    if (repositoryEntries === undefined) {
      entriesByRepositoryKey.set(key, [entry]);
      continue;
    }
    repositoryEntries.push(entry);
  }

  const byRootId = new Map<string, ThreadRepositoryRow>();
  const byWorktreeId = new Map<string, ThreadRepositoryRow>();
  for (const repositoryEntries of entriesByRepositoryKey.values()) {
    const repository = repositoryRow(repositoryEntries, folderRowsByRootId);
    if (repository === undefined) {
      continue;
    }
    for (const entry of repositoryEntries.filter(isRepositoryCheckout)) {
      if (entry.rootId !== null && entry.rootIdIsExactMount) {
        byRootId.set(entry.rootId, repository);
      }
      if (entry.id !== null && !entry.primary) {
        byWorktreeId.set(entry.id, repository);
      }
    }
  }
  return { byRootId, byWorktreeId };
}

/**
 * Every root id folder grouping needs a `roots` row for: the folder each
 * thread names, and each repository's own checkout when it is an open folder.
 * A repository is named by that folder, which no thread may name while all of
 * them work in its worktrees.
 */
export function listFolderGroupingRootIds(
  threads: readonly AssistantMemoryThread[],
  entries: readonly WorktreeListEntry[] | null
): string[] {
  const rootIds = new Set<string>();
  for (const thread of threads) {
    const rootId = getThreadPrimaryRootId(thread);
    if (rootId !== null) {
      rootIds.add(rootId);
    }
  }
  for (const entry of entries ?? []) {
    const rootId = entry.primary ? ownFolderRootId(entry) : null;
    if (rootId !== null) {
      rootIds.add(rootId);
    }
  }
  return [...rootIds];
}

/**
 * The repository `thread` works in, or `undefined` when its folder is not one
 * of a repository's checkouts (or it has no folder). The worktree its binding
 * names is asked first: that id is the ledger's, and it resolves even while
 * the worktree's own folder is not open.
 */
export function resolveThreadRepository(
  thread: AssistantMemoryThread,
  lookup: ThreadRepositoryLookup
): ThreadRepositoryRow | undefined {
  const metadata = thread.metadata;
  const worktreeId =
    metadata?.checkoutMode === 'worktree' ? metadata.checkoutWorktreeId : undefined;
  const byWorktree = worktreeId ? lookup.byWorktreeId.get(worktreeId) : undefined;
  if (byWorktree !== undefined) {
    return byWorktree;
  }
  const rootId = getThreadPrimaryRootId(thread);
  return rootId === null ? undefined : lookup.byRootId.get(rootId);
}

/**
 * The repository each of `threads` works in, keyed by thread id, as the section
 * builder takes it. With no listing (`null`: none served, still loading, or it
 * failed) no repository is named and every thread groups by its folder.
 */
export function mapThreadRepositories(
  threads: readonly AssistantMemoryThread[],
  entries: readonly WorktreeListEntry[] | null,
  folderRowsByRootId: ReadonlyMap<string, ThreadFolderGroupingRow>
): ReadonlyMap<string, ThreadRepositoryRow> {
  if (entries === null) {
    return NO_REPOSITORY_BY_THREAD_ID;
  }
  const lookup = projectThreadRepositories(entries, folderRowsByRootId);
  const repositoryByThreadId = new Map<string, ThreadRepositoryRow>();
  for (const thread of threads) {
    const repository = resolveThreadRepository(thread, lookup);
    if (repository !== undefined) {
      repositoryByThreadId.set(thread.id, repository);
    }
  }
  return repositoryByThreadId.size === 0 ? NO_REPOSITORY_BY_THREAD_ID : repositoryByThreadId;
}
