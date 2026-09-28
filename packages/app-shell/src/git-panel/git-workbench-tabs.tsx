import { Tabs, TabsContent, TabsList, TabsTrigger } from '@brainstrike/ui';
import type { ReactElement, ReactNode } from 'react';

export type GitWorkbenchTab = 'changes' | 'history';

function isGitWorkbenchTab(value: string): value is GitWorkbenchTab {
  return value === 'changes' || value === 'history';
}

/**
 * Changes|History on the shared `sm` switcher, in a 36px header row like the
 * other panel headers. Only the active view is mounted.
 */
export function GitWorkbenchTabs({
  active,
  changedFiles,
  changes,
  history,
  onChange,
}: {
  readonly active: GitWorkbenchTab;
  readonly changedFiles: number;
  readonly changes: ReactNode;
  readonly history: ReactNode;
  readonly onChange: (tab: GitWorkbenchTab) => void;
}): ReactElement {
  return (
    <Tabs
      className="flex min-h-0 flex-1 flex-col"
      onValueChange={(value) => {
        if (isGitWorkbenchTab(value)) {
          onChange(value);
        }
      }}
      value={active}
    >
      <div className="flex h-9 shrink-0 items-center border-border border-b px-2">
        <TabsList aria-label="Changes and history" className="grid w-full grid-cols-2" size="sm">
          <TabsTrigger value="changes">
            Changes
            {changedFiles > 0 ? (
              <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums leading-4">
                {changedFiles}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent className="flex min-h-0 flex-1" value="changes">
        {changes}
      </TabsContent>
      <TabsContent className="flex min-h-0 flex-1" value="history">
        {history}
      </TabsContent>
    </Tabs>
  );
}
