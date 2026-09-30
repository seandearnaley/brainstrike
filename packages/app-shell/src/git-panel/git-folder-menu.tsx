import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import type { WorktreeDescriptor } from '@brainstrike/types';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@brainstrike/ui';
import type { ReactElement } from 'react';
import { type UseGitInventoryResult, useGitInventory } from '../changes/use-git-inventory';

function pathKey(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
}

function discoveryMessage(result: UseGitInventoryResult): string | null {
  if (!result.available) {
    return 'Repository discovery is unavailable in this build.';
  }
  if (result.error) {
    return null;
  }
  if (result.loading) {
    return 'Discovering repositories…';
  }
  if (!result.inventory) {
    return 'Repository discovery has not completed.';
  }
  return result.inventory.repositories.length === 0 && result.inventory.errors.length === 0
    ? 'No repositories discovered in connected folders.'
    : null;
}

function unmountedReason(worktree: WorktreeDescriptor): string {
  if (worktree.trust === 'unvalidated') {
    return worktree.trustReason ?? 'This worktree could not be verified against its own .git.';
  }
  if (worktree.containment === 'outside-roots') {
    return 'This worktree is outside the connected workspace folders.';
  }
  if (worktree.lockedReason !== null) {
    return `Locked: ${worktree.lockedReason}`;
  }
  if (worktree.prunableReason !== null) {
    return `Unavailable: ${worktree.prunableReason}`;
  }
  return 'Open this repository as a workspace folder to focus it.';
}

/** Mounted only while the user opens the picker; closing also releases discovery. */
export function GitFolderMenu(): ReactElement {
  const { rootDirectoryHandle, rootDirectoryHandles, setFocusedRoot } = useFileSystem();
  const discovery = useGitInventory();
  const roots =
    rootDirectoryHandles.length > 0
      ? rootDirectoryHandles
      : rootDirectoryHandle
        ? [rootDirectoryHandle]
        : [];
  const focusedId = rootDirectoryHandle?.rootId;
  const worktrees =
    discovery.inventory?.repositories.flatMap((repository) => repository.worktrees) ?? [];
  const mountedPaths = new Set(roots.map((root) => pathKey(root.path)));
  // Path equality is a display hint only, never a grant or a containing-parent guess.
  const discoveredPaths = new Set(worktrees.map((worktree) => pathKey(worktree.path)));
  const unmounted = [
    ...new Map(
      worktrees
        .filter((worktree) => !mountedPaths.has(pathKey(worktree.path)))
        .map((worktree) => [worktree.path, worktree])
    ).values(),
  ];
  const errors = discovery.error ? [discovery.error] : (discovery.inventory?.errors ?? []);
  const message = discoveryMessage(discovery);

  return (
    <>
      <DropdownMenuLabel>Switch repository or focused folder</DropdownMenuLabel>
      <p className="px-2 py-1.5 text-muted-foreground text-xs">
        Git follows the Focused folder. Switching changes the Focused folder. Main stays the same.
      </p>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup
        onValueChange={(id) => {
          // Revalidate against the live mounted set; never focus an inventory-only path.
          if (id !== focusedId && roots.some((root) => root.rootId === id)) {
            setFocusedRoot(id);
          }
        }}
        value={focusedId ?? ''}
      >
        {roots.map((root) => {
          const id = root.rootId;
          return (
            <DropdownMenuRadioItem
              aria-description={id ? undefined : 'Folder is still being restored.'}
              aria-label={`Focus folder ${root.name}: ${root.path}`}
              disabled={!id}
              key={id ?? root.path}
              value={id ?? `pending:${root.path}`}
            >
              <span className="min-w-0">
                <span className="block font-medium">{root.name}</span>
                <span className="block break-all text-muted-foreground text-xs">{root.path}</span>
                <span className="block text-muted-foreground text-xs">
                  {id
                    ? discoveredPaths.has(pathKey(root.path))
                      ? 'Git repository'
                      : 'Connected folder'
                    : 'Folder is still being restored.'}
                </span>
              </span>
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
      {roots.length === 0 ? (
        <p className="px-2 py-1.5 text-muted-foreground text-xs">
          Open a workspace folder to switch here.
        </p>
      ) : null}
      {message ? (
        <p aria-live="polite" className="px-2 py-1.5 text-muted-foreground text-xs">
          {message}
        </p>
      ) : null}
      {errors.length > 0 ? (
        <div className="px-2 py-1.5 text-destructive text-xs" role="alert">
          <p>Repository discovery is incomplete.</p>
          <ul className="list-inside list-disc break-words">
            {[...new Set(errors)].map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {discovery.available && !discovery.loading ? (
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            void discovery.refresh();
          }}
        >
          {errors.length > 0 ? 'Retry repository discovery' : 'Refresh repository discovery'}
        </DropdownMenuItem>
      ) : null}
      {unmounted.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Other discovered repositories and worktrees</DropdownMenuLabel>
          {unmounted.map((worktree) => (
            <DropdownMenuItem
              aria-description={unmountedReason(worktree)}
              aria-label={`${worktree.name}: ${worktree.path}`}
              disabled
              key={worktree.path}
            >
              <span className="min-w-0">
                <span className="block font-medium">{worktree.name}</span>
                <span className="block break-all text-xs">{worktree.path}</span>
                <span className="block whitespace-normal text-xs">{unmountedReason(worktree)}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </>
      ) : null}
    </>
  );
}
