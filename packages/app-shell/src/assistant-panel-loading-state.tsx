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
      {/* Holds the composer's place at about its resting height, so the
          thread body does not jump when the real composer mounts. */}
      <div
        aria-hidden="true"
        className="border-border shrink-0 border-t px-2.5 pt-2 pb-2.5"
        data-testid="assistant-panel-loading-composer"
      >
        <div className="mb-2 flex h-6 items-center gap-2">
          <div className="bg-muted/45 h-5 w-28 rounded-full" />
          <div className="bg-muted/45 h-5 w-20 rounded-full" />
        </div>
        <div className="border-border bg-muted/20 h-28 rounded-2xl border" />
      </div>
    </div>
  );
}
