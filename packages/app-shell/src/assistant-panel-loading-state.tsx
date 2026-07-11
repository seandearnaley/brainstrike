import type { ReactElement } from 'react';

export function AssistantPanelLoadingState({ label }: { readonly label: string }): ReactElement {
  return (
    <div
      aria-label={label}
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background"
      data-testid="assistant-panel-loading"
      role="status"
    >
      <div
        className="flex h-12 shrink-0 items-center gap-2 border-border border-b bg-muted/20 px-2"
        data-testid="assistant-panel-loading-tab-strip"
      >
        <div aria-hidden="true" className="size-8 rounded-full bg-muted/55" />
        <div aria-hidden="true" className="h-8 min-w-0 flex-1 rounded-t-lg bg-muted/45" />
        <div aria-hidden="true" className="size-8 rounded-full bg-muted/55" />
        <div aria-hidden="true" className="h-8 w-16 rounded-full bg-muted/55" />
        <span className="sr-only">{label}</span>
      </div>
      <div aria-hidden="true" className="min-h-0 flex-1 bg-background" />
    </div>
  );
}
