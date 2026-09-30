import { Button } from '@brainstrike/ui';
import { RefreshCw } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import type { GitRepository, GitStatus } from './git-bridge';
import { GitChangesView } from './git-changes-view';
import { GitFocusedFolder } from './git-focused-folder';
import { GitHistoryView } from './git-history-view';
import { GitWorkbenchHeader } from './git-workbench-header';
import { type GitWorkbenchTab, GitWorkbenchTabs } from './git-workbench-tabs';
import { type UseGitPanelResult, useGitPanel } from './use-git-panel';

function formatWorkspaceScope(openedRoot: string, worktreeRoot: string): string {
  const normalizedOpenedRoot = openedRoot.replaceAll('\\', '/').replace(/\/+$/, '');
  const normalizedWorktreeRoot = worktreeRoot.replaceAll('\\', '/').replace(/\/+$/, '');
  const worktreePrefix = `${normalizedWorktreeRoot}/`;

  if (!normalizedOpenedRoot.startsWith(worktreePrefix)) {
    return openedRoot;
  }
  return normalizedOpenedRoot.slice(worktreePrefix.length);
}

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

function MissingFocusedRoot({ panel }: { readonly panel: UseGitPanelResult }): ReactElement {
  if (panel.isRestoringFolders) {
    return (
      <CenteredMessage testId="git-panel-restoring">
        {panel.focusedFolder ? 'Waiting for focused folder…' : 'Restoring workspace folders…'}
      </CenteredMessage>
    );
  }
  if (panel.focusedFolder) {
    return (
      <CenteredMessage testId="git-panel-folder-unavailable">
        This folder's identity is unavailable. Switch to another folder or reopen this folder to use
        Git.
      </CenteredMessage>
    );
  }
  return (
    <CenteredMessage testId="git-panel-no-root">
      Open a workspace folder to review and commit changes with Git.
    </CenteredMessage>
  );
}

/** Desktop-only, local-first Git workbench for changes, commits, branches and history. */
function GitPanelContent({ panel }: { readonly panel: UseGitPanelResult }): ReactElement {
  const [tab, setTab] = useState<GitWorkbenchTab>('changes');

  if (!panel.activeRootId) {
    return <MissingFocusedRoot panel={panel} />;
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

  return (
    <GitRepositoryPanel
      panel={panel}
      repository={panel.repository}
      setTab={setTab}
      status={panel.status}
      tab={tab}
    />
  );
}

function GitRepositoryPanel({
  panel,
  repository,
  status,
  tab,
  setTab,
}: {
  readonly panel: UseGitPanelResult;
  readonly repository: GitRepository;
  readonly status: GitStatus;
  readonly tab: GitWorkbenchTab;
  readonly setTab: (tab: GitWorkbenchTab) => void;
}): ReactElement {
  const viewKey = `${panel.activeRootId ?? 'no-root'}:${repository.currentWorktree.branch ?? 'detached'}:${repository.currentWorktree.head ?? 'unborn'}`;
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
      data-testid="git-panel"
    >
      <GitWorkbenchHeader
        fetchRemote={panel.fetchRemote}
        isLoading={panel.isLoading}
        isSyncing={panel.isSyncing}
        refreshStatus={panel.refresh}
        repository={repository}
        status={status}
        switchBranch={panel.switchBranch}
      />
      {repository.scope === 'workspace' ? (
        <div className="shrink-0 border-amber-500/25 border-b bg-amber-500/8 px-3 py-1.5 text-warning text-xs">
          Showing changes for{' '}
          {formatWorkspaceScope(repository.openedRoot, repository.currentWorktree.path)} only.
        </div>
      ) : null}
      <GitWorkbenchTabs
        active={tab}
        changedFiles={status.files.length}
        changes={
          <GitChangesView key={viewKey} panel={panel} repository={repository} status={status} />
        }
        history={<GitHistoryView key={viewKey} panel={panel} repository={repository} />}
        onChange={setTab}
      />
    </div>
  );
}

/** Keep orientation and switching available even when this folder has no repository. */
export function GitPanel(): ReactElement {
  const panel = useGitPanel();
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <GitFocusedFolder />
      <div className="min-h-0 flex-1 overflow-hidden">
        <GitPanelContent panel={panel} />
      </div>
    </div>
  );
}
