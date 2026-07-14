import type { ReactElement } from 'react';

export type GitWorkbenchTab = 'changes' | 'history';

export function GitWorkbenchTabs({
  active,
  changedFiles,
  onChange,
}: {
  readonly active: GitWorkbenchTab;
  readonly changedFiles: number;
  readonly onChange: (tab: GitWorkbenchTab) => void;
}): ReactElement {
  return (
    <div className="grid h-10 shrink-0 grid-cols-2 border-border border-b" role="tablist">
      <button
        aria-selected={active === 'changes'}
        className={`relative text-sm transition-colors hover:bg-accent/40 ${
          active === 'changes' ? 'font-medium text-foreground' : 'text-muted-foreground'
        }`}
        onClick={() => onChange('changes')}
        role="tab"
        type="button"
      >
        Changes
        {changedFiles > 0 ? (
          <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
            {changedFiles}
          </span>
        ) : null}
        {active === 'changes' ? (
          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
        ) : null}
      </button>
      <button
        aria-selected={active === 'history'}
        className={`relative text-sm transition-colors hover:bg-accent/40 ${
          active === 'history' ? 'font-medium text-foreground' : 'text-muted-foreground'
        }`}
        onClick={() => onChange('history')}
        role="tab"
        type="button"
      >
        History
        {active === 'history' ? (
          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
        ) : null}
      </button>
    </div>
  );
}
