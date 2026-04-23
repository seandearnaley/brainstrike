import { Button } from '@brainstrike/ui';
import { ArrowRight, Database, Plus, Search } from 'lucide-react';
import type { ReactElement } from 'react';

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
          Thread history is intentionally placeholder-only in this slice.
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div
          className="rounded-xl border border-border border-dashed bg-background/70 p-4"
          data-testid="threads-placeholder-card"
        >
          <div className="font-medium text-sm">Your agent threads will appear here</div>
          <p className="pt-2 text-muted-foreground text-xs leading-5">
            This preview keeps the shell structure in place without shipping fake history entries.
            DB-backed thread loading and persistence land in a later slice.
          </p>
          <div className="pt-4">
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
              <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div>
                <div className="font-medium text-xs">Upcoming thread history</div>
                <div className="pt-1 text-[11px] text-muted-foreground">
                  Recent agents, pinned work, and resumable sessions will live here.
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
              <Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div>
                <div className="font-medium text-xs">Database stays next door</div>
                <div className="pt-1 text-[11px] text-muted-foreground">
                  Use the Database tab for index tuning and collection diagnostics.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
