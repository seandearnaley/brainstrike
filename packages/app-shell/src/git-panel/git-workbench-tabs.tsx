import { type KeyboardEvent, type ReactElement, useRef } from 'react';

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
  const changesRef = useRef<HTMLButtonElement>(null);
  const historyRef = useRef<HTMLButtonElement>(null);

  const selectAndFocus = (tab: GitWorkbenchTab): void => {
    onChange(tab);
    (tab === 'changes' ? changesRef : historyRef).current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    let nextTab: GitWorkbenchTab;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
        nextTab = active === 'changes' ? 'history' : 'changes';
        break;
      case 'End':
        nextTab = 'history';
        break;
      case 'Home':
        nextTab = 'changes';
        break;
      default:
        return;
    }
    event.preventDefault();
    selectAndFocus(nextTab);
  };

  return (
    <div
      aria-orientation="horizontal"
      className="grid h-10 shrink-0 grid-cols-2 border-border border-b"
      role="tablist"
    >
      <button
        aria-controls="git-workbench-changes-panel"
        aria-selected={active === 'changes'}
        className={`relative text-sm transition-colors hover:bg-accent/40 ${
          active === 'changes' ? 'font-medium text-foreground' : 'text-muted-foreground'
        }`}
        id="git-workbench-changes-tab"
        onClick={() => onChange('changes')}
        onKeyDown={handleKeyDown}
        ref={changesRef}
        role="tab"
        tabIndex={active === 'changes' ? 0 : -1}
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
        aria-controls="git-workbench-history-panel"
        aria-selected={active === 'history'}
        className={`relative text-sm transition-colors hover:bg-accent/40 ${
          active === 'history' ? 'font-medium text-foreground' : 'text-muted-foreground'
        }`}
        id="git-workbench-history-tab"
        onClick={() => onChange('history')}
        onKeyDown={handleKeyDown}
        ref={historyRef}
        role="tab"
        tabIndex={active === 'history' ? 0 : -1}
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
