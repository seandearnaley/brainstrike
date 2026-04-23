import { Button } from '@brainstrike/ui';
import { MessageSquare, Plus } from 'lucide-react';
import type { ReactElement } from 'react';
import { useAssistantThreadStore } from './assistant-thread-store';

export function ThreadsPanel(): ReactElement {
  const selectedThreadByResourceId = useAssistantThreadStore(
    (state) => state.selectedThreadByResourceId
  );
  const createThread = useAssistantThreadStore((state) => state.createThread);
  const entries = Object.entries(selectedThreadByResourceId).sort(([left], [right]) =>
    left.localeCompare(right)
  );

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
          aria-label="New thread"
          className="h-8 gap-1.5 px-2.5"
          data-testid="new-agent-button"
          disabled={entries.length === 0}
          onClick={() => {
            const resourceId = entries[0]?.[0];
            if (resourceId) {
              createThread(resourceId);
            }
          }}
          size="sm"
          title={
            entries.length > 0
              ? 'Create a new thread for this workspace.'
              : 'Open a workspace to create threads.'
          }
          type="button"
          variant="secondary"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="text-xs">New Thread</span>
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {entries.length === 0 ? (
          <div
            className="rounded-xl border border-border border-dashed bg-background/70 p-4"
            data-testid="threads-placeholder-card"
          >
            <div className="font-medium text-sm">No workspace thread selected</div>
            <p className="pt-2 text-muted-foreground text-xs leading-5">
              Open a workspace and the assistant will create a Mastra memory thread scoped to that
              workspace.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map(([resourceId, threadId]) => (
              <div
                className="rounded-lg border border-border bg-background px-3 py-2"
                data-testid="thread-row"
                key={`${resourceId}:${threadId}`}
              >
                <div className="flex items-center gap-2 font-medium text-xs">
                  <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{threadId}</span>
                </div>
                <div className="pt-1 text-[11px] text-muted-foreground">{resourceId}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
