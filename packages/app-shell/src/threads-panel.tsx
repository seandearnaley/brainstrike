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
        summary: 'Promote agent shell to first-class app frame',
        project: 'brainstrike',
      },
      {
        id: 'vector-follow-up',
        summary: 'Context explorer token warm-cache regression',
        project: 'brainstrike',
      },
    ],
  },
  {
    label: 'Pinned',
    items: [
      {
        id: 'desktop-llm-host',
        summary: 'Desktop local LLM host lifecycle cleanup',
        project: 'brainstrike',
      },
      {
        id: 'db-import',
        summary: 'Database import ergonomics and telemetry',
        project: 'brainstrike',
      },
    ],
  },
] as const;

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
          <div className="font-medium text-sm">Threads</div>
          <div className="text-muted-foreground text-xs">Agent workstreams across this app</div>
        </div>
        <Button
          aria-label="New agent"
          className="h-8 gap-1.5 px-2.5"
          data-testid="new-agent-button"
          size="sm"
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
          <span>Search threads</span>
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
                    aria-pressed={isSelected}
                    className={cn(
                      'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                      isSelected
                        ? 'border-primary/30 bg-primary/10 shadow-sm'
                        : 'border-transparent bg-background/80 hover:border-border hover:bg-background'
                    )}
                    data-testid={isSelected ? 'selected-thread-row' : undefined}
                    key={item.id}
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
