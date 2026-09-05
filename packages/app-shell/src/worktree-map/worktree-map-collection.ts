import type { WorktreeCheckoutStatusState } from './use-worktree-checkout-status';
import type { WorktreeMapCardModel, WorktreeMapRepositoryModel } from './worktree-map-model';

export type WorktreeFilter = 'all' | 'attention' | 'external' | 'running';
export type WorktreeSort = 'name' | 'recent';
export const WORKTREE_PAGE_SIZE = 25;

function needsAttention(
  card: WorktreeMapCardModel,
  status: WorktreeCheckoutStatusState | undefined
): boolean {
  return (
    !(card.entry.primary || card.entry.usable) ||
    status?.kind === 'error' ||
    (status?.kind === 'ready' &&
      (!status.value.clean || (status.value.behind !== null && status.value.behind > 0))) ||
    card.pullRequest?.checksRollup === 'failing'
  );
}

function matchesFilter(
  card: WorktreeMapCardModel,
  filter: WorktreeFilter,
  status: WorktreeCheckoutStatusState | undefined
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'attention':
      return needsAttention(card, status);
    case 'external':
      return !(card.entry.primary || card.entry.managed);
    case 'running':
      return card.thread?.running === true;
    default:
      throw new Error(`Unsupported worktree filter: ${String(filter)}`);
  }
}

function activityTime(card: WorktreeMapCardModel): number | null {
  const time =
    card.thread?.updatedAt?.getTime() ?? (card.createdAt ? Date.parse(card.createdAt) : Number.NaN);
  return Number.isFinite(time) ? time : null;
}

function compareCards(
  a: WorktreeMapCardModel,
  b: WorktreeMapCardModel,
  sort: WorktreeSort
): number {
  if (a.entry.primary !== b.entry.primary) {
    return a.entry.primary ? -1 : 1;
  }
  if (sort === 'recent') {
    const aTime = activityTime(a);
    const bTime = activityTime(b);
    if (aTime !== bTime) {
      if (aTime === null) {
        return 1;
      }
      if (bTime === null) {
        return -1;
      }
      return bTime - aTime;
    }
  } else if (sort !== 'name') {
    throw new Error(`Unsupported worktree sort: ${String(sort)}`);
  }
  return (
    a.entry.name.localeCompare(b.entry.name, undefined, { numeric: true }) ||
    a.entry.path.localeCompare(b.entry.path)
  );
}

/** A local view of the canonical projection; never fetches or persists facts. */
export function selectWorktreeCollection(input: {
  readonly filter: WorktreeFilter;
  readonly page: number;
  readonly query: string;
  readonly repositories: readonly WorktreeMapRepositoryModel[];
  readonly sort: WorktreeSort;
  readonly statusByPath: ReadonlyMap<string, WorktreeCheckoutStatusState>;
}): {
  readonly matched: number;
  readonly page: number;
  readonly pageCount: number;
  readonly repositories: readonly WorktreeMapRepositoryModel[];
  readonly total: number;
} {
  const tokens = input.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const filtered = input.repositories.map((repository) => ({
    ...repository,
    cards: repository.cards
      .filter((card) => {
        if (!matchesFilter(card, input.filter, input.statusByPath.get(card.entry.path))) {
          return false;
        }
        if (tokens.length === 0) {
          return true;
        }
        const haystack = [
          repository.repositoryName,
          repository.repositoryRoot,
          card.entry.name,
          card.entry.path,
          card.branchLabel,
          card.thread?.title,
          card.provenanceLabel,
          card.pullRequest ? `#${card.pullRequest.number}` : '',
        ]
          .join(' ')
          .toLocaleLowerCase();
        return tokens.every((token) => haystack.includes(token));
      })
      .sort((a, b) => compareCards(a, b, input.sort)),
  }));
  const total = input.repositories.reduce((sum, repository) => sum + repository.cards.length, 0);
  const matched = filtered.reduce((sum, repository) => sum + repository.cards.length, 0);
  const pageCount = Math.max(1, Math.ceil(matched / WORKTREE_PAGE_SIZE));
  const page = Math.min(input.page, pageCount - 1);
  let offset = 0;
  const repositories = filtered
    .map((repository) => {
      const start = Math.max(0, page * WORKTREE_PAGE_SIZE - offset);
      const end = Math.max(0, (page + 1) * WORKTREE_PAGE_SIZE - offset);
      offset += repository.cards.length;
      return { ...repository, cards: repository.cards.slice(start, end) };
    })
    .filter((repository) => repository.cards.length > 0);
  return { matched, page, pageCount, repositories, total };
}
