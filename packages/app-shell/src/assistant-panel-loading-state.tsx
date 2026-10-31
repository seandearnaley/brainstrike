import type { ReactElement } from 'react';

export function AssistantPanelLoadingState({ label }: { readonly label: string }): ReactElement {
  return (
    <div
      aria-label={label}
      className="bg-background flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="assistant-panel-loading"
      role="status"
    >
      <div
        className="app-window-drag border-border bg-muted/20 flex h-9 shrink-0 items-center gap-2 border-b px-2"
        data-testid="assistant-panel-loading-tab-strip"
      >
        <div aria-hidden="true" className="bg-muted/55 size-7 rounded-full" />
        <div aria-hidden="true" className="bg-muted/45 h-7 min-w-0 flex-1 rounded-t-lg" />
        <div aria-hidden="true" className="bg-muted/55 size-7 rounded-full" />
        <div aria-hidden="true" className="bg-muted/55 h-7 w-16 rounded-full" />
        <span className="sr-only">{label}</span>
      </div>
      <div aria-hidden="true" className="bg-background min-h-0 flex-1" />
    </div>
  );
}
