import { Button, cn } from '@brainstrike/ui';
import { Bot, MoreHorizontal, Plus, Search } from 'lucide-react';
import type { ReactElement } from 'react';

interface ThreadGroup {
  items: readonly {
    id: string;
    project: string;
    summary: string;
  }[];
  label: string;
}

const THREAD_GROUPS: readonly ThreadGroup[] = [
  {
    label: 'Today',
    items: [
      {
        id: 'current-session',
        summary: 'Example workspace thread',
        project: 'demo-project',
      },
      {
        id: 'vector-follow-up',
        summary: 'Follow-up example thread',
        project: 'demo-project',
      },
    ],
  },
  {
    label: 'Pinned',
    items: [
      {
        id: 'desktop-llm-host',
        summary: 'Example pinned thread',
        project: 'demo-project',
      },
      {
        id: 'db-import',
        summary: 'Index tuning example',
        project: 'demo-project',
      },
    ],
  },
] as const;

// TODO: Replace placeholder selection with DB-backed agent thread state.
const SELECTED_THREAD_ID = 'current-session';

export function ThreadsPanel(): ReactElement {
  return (
    <section
      aria-label="Threads"
      className="flex min-h-0 flex-col border-border border-b bg-muted/20"
      data-testid="threads-panel"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="font-medium text-sm">Threads</div>
            <span
              className="rounded-full border border-border bg-background px-2 py-0.5 font-medium text-[10px] text-muted-foreground uppercase tracking-[0.18em]"
              data-testid="threads-preview-badge"
            >
              Preview
            </span>
          </div>
          <div className="text-muted-foreground text-xs">Preview agent history for this app</div>
        </div>
        <Button
          aria-label="New agent"
          className="h-8 gap-1.5 px-2.5"
          data-testid="new-agent-button"
          disabled
          size="sm"
          title="New agent creation is preview-only in this slice."
          type="button"
          variant="secondary"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="text-xs">New Agent</span>
        </Button>
      </div>

      <div className="px-3 pb-3">
        <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-2 text-muted-foreground text-xs">
          <Search className="h-3.5 w-3.5" />
          <span>Search threads coming soon</span>
        </div>
        <div className="pt-2 text-[11px] text-muted-foreground">
          Placeholder agent history for this shell slice.
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {THREAD_GROUPS.map((group) => (
          <div className="pb-3" key={group.label}>
            <div className="px-2 pb-2 font-medium text-[11px] text-muted-foreground/80 uppercase tracking-[0.18em]">
              {group.label}
            </div>
            <div className="space-y-1">
              {group.items.map((item) => {
                const isSelected = item.id === SELECTED_THREAD_ID;
                return (
                  <button
                    aria-disabled="true"
                    aria-pressed={isSelected}
                    className={cn(
                      'w-full rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-default disabled:opacity-100',
                      isSelected
                        ? 'border-primary/30 bg-primary/10 shadow-sm'
                        : 'border-transparent bg-background/80 hover:border-border hover:bg-background'
                    )}
                    data-testid={isSelected ? 'selected-thread-row' : undefined}
                    disabled
                    key={item.id}
                    title="Thread history is preview-only in this slice."
                    type="button"
                  >
                    <div className="flex items-start gap-2">
                      <div
                        className={cn(
                          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                          isSelected
                            ? 'bg-primary/15 text-primary'
                            : 'bg-muted text-muted-foreground'
                        )}
                      >
                        <Bot className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-sm">{item.summary}</div>
                        <div className="truncate pt-1 text-[11px] text-muted-foreground">
                          {item.project}
                        </div>
                      </div>
                      <MoreHorizontal className="mt-1 h-3.5 w-3.5 text-muted-foreground/70" />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
