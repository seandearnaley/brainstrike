import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import { Badge, Button, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import { useId } from 'react';

/**
 * Status-bar surface for the workspace's root identity (multi-root "Main vs
 * Focused" clarity):
 * - No mounted roots → renders nothing.
 * - Single root → folder icon + name (no "Main" wording — there is nothing to
 *   disambiguate).
 * - Multi root → the MAIN root's name (activeRootIds[0] — the assistant's
 *   operating root) + a muted "+N" for the other mounted roots.
 * The popover lists every mounted root with its full path (or "browser
 * folder" for web FSA roots without an absolute path), a Main badge, a
 * Focused marker (selection state, currentFolderId), and a per-row
 * "Set as main" action that reorders the store (pure client reorder — the
 * next request's enrichment follows it).
 */

/** Absolute path heuristic: POSIX or Windows drive/UNC. Web FSA paths are neither. */
function isAbsolutePathLike(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

interface RootRowModel {
  readonly displayName: string;
  readonly isFocused: boolean;
  readonly isMain: boolean;
  readonly pathLabel: string;
  readonly rootId: string;
}

function RootRow({
  root,
  onSetMainRoot,
}: {
  readonly root: RootRowModel;
  readonly onSetMainRoot: (rootId: string) => void;
}) {
  return (
    <li className="flex items-center gap-2 px-3 py-2" data-testid="workspace-root-row">
      <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-xs">{root.displayName}</span>
          {root.isMain && (
            <Badge className="px-1.5 py-0 text-[9px]" variant="secondary">
              Main
            </Badge>
          )}
          {root.isFocused && (
            <span className="shrink-0 text-[10px] text-muted-foreground">Focused</span>
          )}
        </div>
        <div className="truncate text-[11px] text-muted-foreground" title={root.pathLabel}>
          {root.pathLabel}
        </div>
      </div>
      {!root.isMain && (
        <Button
          className="h-6 shrink-0 px-2 text-[11px]"
          onClick={() => onSetMainRoot(root.rootId)}
          size="sm"
          type="button"
          variant="outline"
        >
          Set as main
        </Button>
      )}
    </li>
  );
}

export function WorkspaceRootStatusItem() {
  const popoverTitleId = useId();
  const activeRootIds = useFileExplorerStoreSelector((s) => s.activeRootIds);
  const rootDescriptors = useFileExplorerStoreSelector((s) => s.rootDescriptors);
  const currentFolderId = useFileExplorerStoreSelector((s) => s.currentFolderId);
  const setMainRoot = useFileExplorerStoreSelector((s) => s.setMainRoot);

  const mainRootId = activeRootIds?.[0];
  if (!mainRootId) {
    return null;
  }
  const mainDescriptor = rootDescriptors?.[mainRootId];
  const mainName = mainDescriptor?.displayName ?? mainRootId;
  const otherCount = activeRootIds.length - 1;
  const isMulti = otherCount > 0;

  const rows: RootRowModel[] = activeRootIds.map((rootId) => {
    const descriptor = rootDescriptors?.[rootId];
    const path = descriptor?.path ?? '';
    return {
      displayName: descriptor?.displayName ?? rootId,
      isFocused: currentFolderId !== null && currentFolderId === rootId,
      isMain: rootId === mainRootId,
      pathLabel: isAbsolutePathLike(path) ? path : 'browser folder',
      rootId,
    };
  });
  const mainPathTitle =
    mainDescriptor?.path && isAbsolutePathLike(mainDescriptor.path)
      ? mainDescriptor.path
      : undefined;

  return (
    <Popover>
      <span
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-testid="workspace-root-status-announcement"
        role="status"
      >
        {isMulti
          ? `Workspace main root: ${mainName}, plus ${otherCount} more folder${otherCount === 1 ? '' : 's'}`
          : `Workspace folder: ${mainName}`}
      </span>
      <PopoverTrigger asChild>
        <button
          aria-label={
            isMulti
              ? `Workspace main root ${mainName} plus ${otherCount} more. Open workspace folders`
              : `Workspace folder ${mainName}. Open workspace folders`
          }
          className="flex h-7 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-sm px-1.5 text-left transition-[background-color,color] duration-150 hover:bg-accent/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset md:px-2"
          data-testid="workspace-root-status-trigger"
          title={mainPathTitle}
          type="button"
        >
          <Folder aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          <span aria-hidden="true" className="hidden min-w-0 items-center gap-1 md:flex">
            <span className="min-w-0 truncate whitespace-nowrap text-xs">{mainName}</span>
            {isMulti && (
              <span className="shrink-0 text-muted-foreground text-xs">+{otherCount}</span>
            )}
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        aria-labelledby={popoverTitleId}
        className="w-[min(22rem,calc(100vw-1rem))] p-0"
        collisionPadding={8}
        data-testid="workspace-root-status-popover"
        side="top"
        sideOffset={8}
      >
        <div className="border-b bg-muted/20 px-3 py-2">
          <div className="font-semibold text-sm" id={popoverTitleId}>
            Workspace folders
          </div>
          {isMulti && (
            <div className="text-[11px] text-muted-foreground">
              The assistant operates in the Main root; Focused follows your selection.
            </div>
          )}
        </div>
        <ul className="max-h-72 divide-y overflow-y-auto">
          {rows.map((root) => (
            <RootRow key={root.rootId} onSetMainRoot={setMainRoot} root={root} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
