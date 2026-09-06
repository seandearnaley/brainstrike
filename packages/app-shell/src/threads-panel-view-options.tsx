/**
 * The Threads panel's whole view surface: grouping, sorting AND the Show only
 * filters, in ONE popover.
 *
 * The filters live in here rather than in a bar of their own because panel
 * chrome is TWO rows (toolbar + search) and a filter bar would be a third —
 * see `docs/agents/assistant-persistence.md`. Everything is prop-driven; the
 * panel owns the state.
 */
import type {
  ThreadFilters,
  ThreadsPanelFolderSortBy,
  ThreadsPanelGroupBy,
  ThreadsPanelSortBy,
} from '@brainstrike/assistant-data';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { Check, SlidersHorizontal } from 'lucide-react';
import type { ReactElement } from 'react';
import { hasActiveThreadFilters } from './thread-panel-content-state';

const GROUP_BY_OPTIONS: readonly { readonly label: string; readonly value: ThreadsPanelGroupBy }[] =
  [
    { label: 'Custom groups', value: 'custom-groups' },
    { label: 'Folder', value: 'folder' },
    { label: 'No grouping', value: 'none' },
  ];

const SORT_BY_OPTIONS: readonly { readonly label: string; readonly value: ThreadsPanelSortBy }[] = [
  { label: 'Recency', value: 'recency' },
  { label: 'Name', value: 'name' },
  { label: 'Custom', value: 'custom' },
];

// Folder sections carry no manual order (`buildThreadListSections` sorts them
// itself), so Custom is not on offer there — it would be a control with nothing
// to persist.
const FOLDER_SORT_BY_OPTIONS: readonly {
  readonly label: string;
  readonly value: ThreadsPanelFolderSortBy;
}[] = [
  { label: 'Recency', value: 'recency' },
  { label: 'Name', value: 'name' },
];

const THREAD_FILTER_OPTIONS: readonly {
  readonly label: string;
  readonly value: keyof ThreadFilters;
}[] = [
  { label: 'Running', value: 'running' },
  { label: 'Needs you', value: 'needsYou' },
  { label: 'Unseen', value: 'unseen' },
  { label: 'Has PR', value: 'hasPr' },
];

/**
 * The `name` of each radiogroup's inputs. NOT decoration: without a `name` the
 * browser treats every radio on the page as ONE implicit group, so ArrowDown
 * off the last "Group by" option moved into "Sort by" AND selected it, quietly
 * discarding the user's sort — and every radio was its own tab stop, six of
 * them before the first "Show only" checkbox. A distinct name per group makes
 * the NATIVE grouping match the `role="radiogroup"` grouping, which is what
 * confines the arrow keys and collapses each group to one roving tab stop. A
 * hand-rolled keydown handler would only re-implement that, worse.
 *
 * `folder-sort` is separate from `sort` because folder mode swaps in a
 * different option set backed by different state, in the same visual slot.
 */
const RADIO_GROUP_NAMES = {
  folderSort: 'threads-folder-sort',
  group: 'threads-group-by',
  sort: 'threads-sort-by',
} as const;

const VIEW_OPTION_LABEL_CLASS =
  'flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-inset';

function ViewOptionRadio({
  checked,
  groupName,
  label,
  onSelect,
}: {
  readonly checked: boolean;
  /** See {@link RADIO_GROUP_NAMES} — one distinct name per radiogroup. */
  readonly groupName: string;
  readonly label: string;
  readonly onSelect: () => void;
}): ReactElement {
  return (
    <label className={`${VIEW_OPTION_LABEL_CLASS} ${checked ? 'bg-accent/60 font-medium' : ''}`}>
      <input
        checked={checked}
        className="sr-only"
        name={groupName}
        onChange={onSelect}
        type="radio"
        value={label}
      />
      <span>{label}</span>
      {checked ? <Check className="h-3.5 w-3.5" /> : null}
    </label>
  );
}

function ViewOptionCheckbox({
  checked,
  label,
  onToggle,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onToggle: (checked: boolean) => void;
}): ReactElement {
  return (
    <label className={`${VIEW_OPTION_LABEL_CLASS} ${checked ? 'bg-accent/60 font-medium' : ''}`}>
      <input
        checked={checked}
        className="sr-only"
        onChange={(event) => onToggle(event.target.checked)}
        type="checkbox"
      />
      <span>{label}</span>
      {checked ? <Check className="h-3.5 w-3.5" /> : null}
    </label>
  );
}

/**
 * The panel's only view surface: grouping, sorting AND the Show only filters.
 * The filters live INSIDE this popover on purpose — panel chrome is two rows,
 * and a filter bar would be a third. That makes this popover the ONLY place a
 * filter can be undone, so it also carries the clear-all the filtered-empty
 * card sends the user to.
 */
export function ThreadsViewOptionsPopover({
  folderSortBy,
  groupBy,
  hasPrFilterAvailable,
  onClearThreadFilters,
  onFolderSortByChange,
  onGroupByChange,
  onSortByChange,
  onThreadFilterChange,
  sortBy,
  threadFilters,
}: {
  readonly folderSortBy: ThreadsPanelFolderSortBy;
  readonly groupBy: ThreadsPanelGroupBy;
  /**
   * "Has PR" can only ever match while folder grouping is active AND the
   * branch-lookup bridge is present (desktop; web omits it — the
   * omit-don't-stub constraint). Offering the checkbox outside that
   * combination would let a user tick a filter that can never narrow
   * anything but "nothing at all" — see `threads-panel.tsx`'s
   * `hasPrFilterAvailable`, the single source of this flag.
   */
  readonly hasPrFilterAvailable: boolean;
  readonly onClearThreadFilters: () => void;
  readonly onFolderSortByChange: (folderSortBy: ThreadsPanelFolderSortBy) => void;
  readonly onGroupByChange: (groupBy: ThreadsPanelGroupBy) => void;
  readonly onSortByChange: (sortBy: ThreadsPanelSortBy) => void;
  readonly onThreadFilterChange: (filter: keyof ThreadFilters, enabled: boolean) => void;
  readonly sortBy: ThreadsPanelSortBy;
  readonly threadFilters: ThreadFilters;
}): ReactElement {
  const folderGrouping = groupBy === 'folder';
  const filtersActive = hasActiveThreadFilters(threadFilters);
  const filterOptions = hasPrFilterAvailable
    ? THREAD_FILTER_OPTIONS
    : THREAD_FILTER_OPTIONS.filter((option) => option.value !== 'hasPr');
  // The dot answers "is the list you see the default list", so an active filter
  // lights it exactly like a non-default grouping does: a narrowed list with no
  // visible marker is the panel silently hiding threads.
  const hasNonDefaultView = groupBy !== 'custom-groups' || sortBy !== 'recency' || filtersActive;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="View options"
          className="relative"
          size="icon-xs"
          title="View options"
          type="button"
          variant="ghost"
        >
          <SlidersHorizontal className="size-3.5" />
          {hasNonDefaultView ? (
            <span
              className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary"
              data-testid="threads-view-options-dot"
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 p-2">
        <div className="grid gap-2">
          <div aria-label="Group by" role="radiogroup">
            <div className="px-2 pb-1 text-[11px] text-muted-foreground">Group by</div>
            {GROUP_BY_OPTIONS.map((option) => (
              <ViewOptionRadio
                checked={groupBy === option.value}
                groupName={RADIO_GROUP_NAMES.group}
                key={option.value}
                label={option.label}
                onSelect={() => onGroupByChange(option.value)}
              />
            ))}
          </div>
          <div aria-label="Sort by" role="radiogroup">
            <div className="px-2 pb-1 text-[11px] text-muted-foreground">Sort by</div>
            {folderGrouping
              ? FOLDER_SORT_BY_OPTIONS.map((option) => (
                  <ViewOptionRadio
                    checked={folderSortBy === option.value}
                    groupName={RADIO_GROUP_NAMES.folderSort}
                    key={option.value}
                    label={option.label}
                    onSelect={() => onFolderSortByChange(option.value)}
                  />
                ))
              : SORT_BY_OPTIONS.map((option) => (
                  <ViewOptionRadio
                    checked={sortBy === option.value}
                    groupName={RADIO_GROUP_NAMES.sort}
                    key={option.value}
                    label={option.label}
                    onSelect={() => onSortByChange(option.value)}
                  />
                ))}
          </div>
          {/* A fieldset, not a div with role="group": same semantics, and the
              legend-free label stays honest to assistive tech. */}
          <fieldset aria-label="Show only" className="min-w-0">
            <div className="px-2 pb-1 text-[11px] text-muted-foreground">Show only</div>
            {filterOptions.map((option) => (
              <ViewOptionCheckbox
                checked={threadFilters[option.value]}
                key={option.value}
                label={option.label}
                onToggle={(checked) => onThreadFilterChange(option.value, checked)}
              />
            ))}
            {/* The one-shot reset the empty-list card points at ("Clear the
                filters in view options"). Rendered only while something is
                ticked: with a default list it would be a control that cannot
                change anything. It lives INSIDE the fieldset so the group a
                screen reader announces is the group it clears. */}
            {filtersActive ? (
              <Button
                className="mt-1 w-full justify-start font-normal text-muted-foreground"
                onClick={onClearThreadFilters}
                size="xs"
                type="button"
                variant="ghost"
              >
                Clear filters
              </Button>
            ) : null}
          </fieldset>
        </div>
      </PopoverContent>
    </Popover>
  );
}
