import { Button } from '@brainstrike/ui';
import { RefreshCw } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { GitChangesView } from './git-changes-view';
import { GitFocusedFolderPath, GitFolderSwitchList } from './git-folder-switcher';
import { GitHistoryView } from './git-history-view';
import { GitWorkbenchHeader } from './git-workbench-header';
import { type GitWorkbenchTab, GitWorkbenchTabs } from './git-workbench-tabs';
import { useGitPanel } from './use-git-panel';

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

/** Desktop-only, local-first Git workbench for changes, commits, branches and history. */
export function GitPanel(): ReactElement {
  const panel = useGitPanel();
  const [tab, setTab] = useState<GitWorkbenchTab>('changes');
  const { focusedFolder } = panel;

  if (!focusedFolder) {
    return (
      <CenteredMessage testId="git-panel-no-root">
        Open a workspace folder to review and commit changes with Git.
      </CenteredMessage>
    );
  }

  // Git follows the explorer's focused root (BST-1897): every state below names
  // that folder, and the ones without a usable repository offer the others.
  const folderSwitcher = (
    <GitFolderSwitchList
      focusedRootId={focusedFolder.rootId}
      folders={panel.workspaceFolders}
      onSelect={panel.focusFolder}
      probe={panel.probeFolder}
    />
  );

  if (panel.statusError) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto p-8 text-center text-sm"
        data-testid="git-panel-error"
      >
        <p className="font-medium text-destructive">
          Could not load Git status for {focusedFolder.name}.
        </p>
        <GitFocusedFolderPath folder={focusedFolder} />
        <p className="max-w-md text-muted-foreground text-xs">{panel.statusError}</p>
        <Button onClick={panel.refresh} size="sm" type="button" variant="outline">
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
        {folderSwitcher}
      </div>
    );
  }

  if (panel.status && !panel.status.isRepository) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto p-8 text-center text-muted-foreground text-sm"
        data-testid="git-panel-not-a-repo"
      >
        <p className="font-medium text-foreground">{focusedFolder.name} is not a Git repository.</p>
        <GitFocusedFolderPath folder={focusedFolder} />
        <p className="max-w-md text-xs leading-relaxed">
          Git shows the folder that is focused in the explorer.
        </p>
        {folderSwitcher}
      </div>
    );
  }

  if (panel.repositoryError) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto p-8 text-center text-sm"
        data-testid="git-panel-error"
      >
        <p className="font-medium text-destructive">
          Could not load repository details for {focusedFolder.name}.
        </p>
        <GitFocusedFolderPath folder={focusedFolder} />
        <p className="max-w-md text-muted-foreground text-xs">{panel.repositoryError}</p>
        <Button onClick={panel.refresh} size="sm" type="button" variant="outline">
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
        {folderSwitcher}
      </div>
    );
  }

  if (!(panel.status && panel.repository)) {
    return (
      <div
        className="grid h-full place-items-center p-8 text-center text-muted-foreground text-sm"
        data-testid="git-panel-loading"
      >
        <div className="flex max-w-md flex-col items-center gap-2 leading-relaxed">
          <p>Loading Git workbench…</p>
          <GitFocusedFolderPath folder={focusedFolder} />
        </div>
      </div>
    );
  }

  const { repository, status } = panel;
  const viewKey = `${panel.activeRootId ?? 'no-root'}:${repository.currentWorktree.branch ?? 'detached'}:${repository.currentWorktree.head ?? 'unborn'}`;
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
      data-testid="git-panel"
    >
      <GitWorkbenchHeader
        fetchRemote={panel.fetchRemote}
        focusedFolder={focusedFolder}
        focusFolder={panel.focusFolder}
        isLoading={panel.isLoading}
        isSyncing={panel.isSyncing}
        probeFolder={panel.probeFolder}
        refreshStatus={panel.refresh}
        repository={repository}
        status={status}
        switchBranch={panel.switchBranch}
        workspaceFolders={panel.workspaceFolders}
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
