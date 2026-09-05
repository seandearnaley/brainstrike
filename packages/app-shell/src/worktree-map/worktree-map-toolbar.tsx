import { Button, Input } from '@brainstrike/ui';
import { ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  WORKTREE_PAGE_SIZE,
  type WorktreeFilter,
  type WorktreeSort,
} from './worktree-map-collection';

const FILTERS = [
  { label: 'All', value: 'all' },
  { label: 'Running', value: 'running' },
  { label: 'Needs attention', value: 'attention' },
  { label: 'External', value: 'external' },
] as const;

export function WorktreeMapToolbar({
  filter,
  loading,
  onFilter,
  onQuery,
  onRefresh,
  onSort,
  query,
  sort,
  total,
}: {
  readonly filter: WorktreeFilter;
  readonly loading: boolean;
  readonly onFilter: (filter: WorktreeFilter) => void;
  readonly onQuery: (query: string) => void;
  readonly onRefresh: () => void;
  readonly onSort: (sort: WorktreeSort) => void;
  readonly query: string;
  readonly sort: WorktreeSort;
  readonly total: number;
}): ReactElement {
  return (
    <header className="flex shrink-0 flex-col gap-3 border-border border-b px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h1 className="font-semibold text-base tracking-tight">Worktrees</h1>
          <span className="text-muted-foreground text-xs tabular-nums">{total} checkouts</span>
        </div>
        <Button
          aria-label="Refresh worktrees"
          disabled={loading}
          onClick={onRefresh}
          size="icon-sm"
          title="Refresh worktrees"
          variant="ghost"
        >
          <RefreshCw className={`size-4 ${loading ? 'motion-safe:animate-spin' : ''}`} />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
          />
          <Input
            aria-label="Search worktrees"
            className="h-8 pl-8 text-xs"
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search worktrees…"
            title="Search checkout name, branch, path, repository or thread"
            type="search"
            value={query}
          />
        </div>
        <label className="flex h-8 items-center gap-2 rounded-md border border-input px-2 text-muted-foreground text-xs">
          Sort
          <select
            aria-label="Sort worktrees"
            className="h-full min-w-0 bg-background text-foreground outline-offset-2"
            onChange={(event) => {
              const value = event.target.value;
              if (value !== 'name' && value !== 'recent') {
                throw new Error(`Unsupported worktree sort: ${value}`);
              }
              onSort(value);
            }}
            value={sort}
          >
            <option value="name">Name</option>
            <option value="recent">Recent activity</option>
          </select>
        </label>
      </div>
      <fieldset aria-label="Filter worktrees" className="flex flex-wrap gap-1">
        {FILTERS.map((item) => (
          <Button
            aria-pressed={filter === item.value}
            key={item.value}
            onClick={() => onFilter(item.value)}
            size="xs"
            variant={filter === item.value ? 'secondary' : 'ghost'}
          >
            {item.label}
          </Button>
        ))}
      </fieldset>
    </header>
  );
}

export function WorktreeMapPagination({
  matched,
  onPage,
  page,
  pageCount,
}: {
  readonly matched: number;
  readonly onPage: (page: number) => void;
  readonly page: number;
  readonly pageCount: number;
}): ReactElement {
  return (
    <nav
      aria-label="Worktree pages"
      className="flex shrink-0 items-center justify-between gap-2 border-border border-t px-4 py-2"
    >
      <span aria-live="polite" className="text-muted-foreground text-xs tabular-nums">
        {matched === 0 ? 0 : page * WORKTREE_PAGE_SIZE + 1}–
        {Math.min((page + 1) * WORKTREE_PAGE_SIZE, matched)} of {matched}
      </span>
      <div className="flex items-center gap-1">
        <Button
          aria-label="Previous page"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-14 text-center text-muted-foreground text-xs tabular-nums">
          {page + 1} / {pageCount}
        </span>
        <Button
          aria-label="Next page"
          disabled={page + 1 >= pageCount}
          onClick={() => onPage(page + 1)}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </nav>
  );
}
