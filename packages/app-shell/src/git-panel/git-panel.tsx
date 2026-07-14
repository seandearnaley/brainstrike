import { Button } from '@brainstrike/ui';
import { RefreshCw } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { GitChangesView } from './git-changes-view';
import { GitHistoryView } from './git-history-view';
import { GitWorkbenchHeader } from './git-workbench-header';
import { type GitWorkbenchTab, GitWorkbenchTabs } from './git-workbench-tabs';
import { useGitPanel } from './use-git-panel';

function CenteredMessage({
  children,
  testId,
}: {
  readonly children: ReactElement | string;
  readonly testId?: string;
}): ReactElement {
  return (
    <div
      className="grid h-full place-items-center p-8 text-center text-muted-foreground text-sm"
      data-testid={testId}
    >
      <div className="max-w-md leading-relaxed">{children}</div>
    </div>
  );
}

/** Desktop-only, local-first Git workbench for changes, commits, branches and history. */
export function GitPanel(): ReactElement {
  const panel = useGitPanel();
  const [tab, setTab] = useState<GitWorkbenchTab>('changes');

  if (!panel.activeRootId) {
    return (
      <CenteredMessage testId="git-panel-no-root">
        Open a workspace folder to review and commit changes with Git.
      </CenteredMessage>
    );
  }

  if (panel.statusError) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm"
        data-testid="git-panel-error"
      >
        <p className="font-medium text-destructive">Could not load Git status.</p>
        <p className="max-w-md text-muted-foreground text-xs">{panel.statusError}</p>
        <Button onClick={panel.refresh} size="sm" type="button" variant="outline">
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  }

  if (panel.status && !panel.status.isRepository) {
    return (
      <CenteredMessage testId="git-panel-not-a-repo">
        This folder is not a Git repository.
      </CenteredMessage>
    );
  }

  if (panel.repositoryError) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm"
        data-testid="git-panel-error"
      >
        <p className="font-medium text-destructive">Could not load repository details.</p>
        <p className="max-w-md text-muted-foreground text-xs">{panel.repositoryError}</p>
        <Button onClick={panel.refresh} size="sm" type="button" variant="outline">
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  }

  if (!(panel.status && panel.repository)) {
    return <CenteredMessage>Loading Git workbench…</CenteredMessage>;
  }

  const { repository, status } = panel;
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
      data-testid="git-panel"
    >
      <GitWorkbenchHeader
        fetchRemote={panel.fetchRemote}
        isSyncing={panel.isSyncing}
        repository={repository}
        status={status}
        switchBranch={panel.switchBranch}
      />
      {repository.scope === 'workspace' ? (
        <div className="shrink-0 border-amber-500/25 border-b bg-amber-500/8 px-3 py-1.5 text-amber-700 text-xs dark:text-amber-300">
          Showing changes for {repository.openedRoot.slice(repository.repositoryRoot.length + 1)}{' '}
          only.
        </div>
      ) : null}
      <GitWorkbenchTabs active={tab} changedFiles={status.files.length} onChange={setTab} />
      {tab === 'changes' ? (
        <GitChangesView
          key={panel.activeRootId}
          panel={panel}
          repository={repository}
          status={status}
        />
      ) : (
        <GitHistoryView key={panel.activeRootId ?? 'no-root'} panel={panel} />
      )}
    </div>
  );
}
