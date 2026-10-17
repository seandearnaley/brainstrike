import { DropdownMenuItem } from '@brainstrike/ui';
import { Folder, FolderGit2 } from 'lucide-react';
import { type ReactElement, useId } from 'react';
import type { GitResult, GitStatus } from './git-bridge';
import { type GitFolderProbe, useGitFolderProbe } from './use-git-folder-probe';
import type { GitWorkspaceFolder } from './use-git-panel';

/**
 * Names the folder Git inspects and lets the user point Git at another mounted
 * root (BST-1897). Git follows the explorer's focused root; switching here uses
 * that same focus action, so Main, root order and trust never change.
 */
interface GitFolderSwitcherProps {
  readonly focusedRootId: string;
  readonly folders: readonly GitWorkspaceFolder[];
  readonly onSelect: (rootId: string) => void;
  readonly probe: (rootId: string) => Promise<GitResult<GitStatus>>;
}

interface ProbePresentation {
  readonly className: string;
  readonly label: string;
  /** Only a root known not to be a repository is disabled; its row says why. */
  readonly selectable: boolean;
}

function presentProbe(probe: GitFolderProbe): ProbePresentation {
  switch (probe.kind) {
    case 'checking':
      return {
        className: 'text-muted-foreground',
        label: 'Checking for a Git repository…',
        selectable: true,
      };
    case 'repository':
      return {
        className: 'text-muted-foreground',
        label: `Git repository · ${probe.branch ?? 'detached HEAD'}`,
        selectable: true,
      };
    case 'not-repository':
      return {
        className: 'text-muted-foreground',
        label: 'Not a Git repository',
        selectable: false,
      };
    case 'error':
      return {
        className: 'text-destructive',
        label: `Could not check Git: ${probe.error}`,
        selectable: true,
      };
    default: {
      const unreachable: never = probe;
      return unreachable;
    }
  }
}

function MainBadge(): ReactElement {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-secondary px-1.5 font-medium text-[9px] text-secondary-foreground leading-4">
      Main
    </span>
  );
}

function focusNote(folders: readonly GitWorkspaceFolder[]): string {
  const main = folders.find((folder) => folder.isMain);
  return main
    ? `Switching changes only the folder Git shows. Main stays ${main.name}.`
    : 'Switching changes only the folder Git shows.';
}

function FolderRowContent({
  folder,
  presentation,
  statusId,
}: {
  readonly folder: GitWorkspaceFolder;
  readonly presentation: ProbePresentation;
  readonly statusId: string;
}): ReactElement {
  const Icon = presentation.selectable ? FolderGit2 : Folder;
  return (
    <span className="flex w-full min-w-0 items-start gap-2">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-sm">{folder.name}</span>
          {folder.isMain ? <MainBadge /> : null}
        </span>
        <span className="block truncate text-muted-foreground text-xs">{folder.path}</span>
        <span className={`mt-0.5 block text-[11px] ${presentation.className}`} id={statusId}>
          {presentation.label}
        </span>
      </span>
    </span>
  );
}

/** The inspected folder's full path, shown in every Git panel state that has one. */
export function GitFocusedFolderPath({
  folder,
}: {
  readonly folder: GitWorkspaceFolder;
}): ReactElement {
  return (
    <p
      className="max-w-md break-all font-mono text-muted-foreground text-xs"
      data-testid="git-panel-focused-folder"
      title={folder.path}
    >
      {folder.path}
    </p>
  );
}

function SwitchListRow({
  folder,
  onSelect,
  probe,
}: {
  readonly folder: GitWorkspaceFolder;
  readonly onSelect: (rootId: string) => void;
  readonly probe: GitFolderProbe;
}): ReactElement {
  const statusId = useId();
  const presentation = presentProbe(probe);
  return (
    <li>
      <button
        aria-describedby={statusId}
        aria-label={`Show ${folder.name} in Git`}
        className="flex w-full px-3 py-2 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
        data-testid="git-folder-switch-item"
        disabled={!presentation.selectable}
        onClick={() => onSelect(folder.rootId)}
        type="button"
      >
        <FolderRowContent folder={folder} presentation={presentation} statusId={statusId} />
      </button>
    </li>
  );
}

/** Inline switcher for the panel's not-a-repository and error states. */
export function GitFolderSwitchList({
  focusedRootId,
  folders,
  onSelect,
  probe,
}: GitFolderSwitcherProps): ReactElement {
  const headingId = useId();
  const others = folders.filter((folder) => folder.rootId !== focusedRootId);
  const probeOf = useGitFolderProbe(
    others.map((folder) => folder.rootId),
    probe
  );
  if (others.length === 0) {
    return (
      <p className="max-w-md text-muted-foreground text-xs">
        Add a folder that is a Git repository to the workspace to use Git here.
      </p>
    );
  }
  return (
    <div className="w-full max-w-md text-left" data-testid="git-folder-switch-list">
      <p className="mb-2 font-medium text-foreground text-xs" id={headingId}>
        Show another workspace folder in Git
      </p>
      <ul aria-labelledby={headingId} className="divide-y divide-border rounded-md border">
        {others.map((folder) => (
          <SwitchListRow
            folder={folder}
            key={folder.rootId}
            onSelect={onSelect}
            probe={probeOf(folder.rootId)}
          />
        ))}
      </ul>
      <p className="mt-2 text-muted-foreground text-xs">{focusNote(folders)}</p>
    </div>
  );
}

function SwitchMenuItem({
  folder,
  onSelect,
  probe,
}: {
  readonly folder: GitWorkspaceFolder;
  readonly onSelect: (rootId: string) => void;
  readonly probe: GitFolderProbe;
}): ReactElement {
  const statusId = useId();
  const presentation = presentProbe(probe);
  return (
    <DropdownMenuItem
      aria-describedby={statusId}
      aria-label={`Show ${folder.name} in Git`}
      data-testid="git-folder-switch-item"
      disabled={!presentation.selectable}
      onSelect={() => onSelect(folder.rootId)}
    >
      <FolderRowContent folder={folder} presentation={presentation} statusId={statusId} />
    </DropdownMenuItem>
  );
}

/**
 * Menu rows for the header's repository menu. Mounted only while the menu is
 * open, so roots are read on that gesture and again on each later open.
 */
export function GitFolderSwitchMenuItems({
  focusedRootId,
  folders,
  onSelect,
  probe,
}: GitFolderSwitcherProps): ReactElement {
  const others = folders.filter((folder) => folder.rootId !== focusedRootId);
  const probeOf = useGitFolderProbe(
    others.map((folder) => folder.rootId),
    probe
  );
  if (others.length === 0) {
    return (
      <div className="px-2 py-1.5 text-muted-foreground text-xs">
        No other workspace folders are open.
      </div>
    );
  }
  return (
    <>
      {others.map((folder) => (
        <SwitchMenuItem
          folder={folder}
          key={folder.rootId}
          onSelect={onSelect}
          probe={probeOf(folder.rootId)}
        />
      ))}
      <div className="px-2 py-1.5 text-muted-foreground text-xs leading-relaxed">
        {focusNote(folders)}
      </div>
    </>
  );
}
