import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { EmptyState } from '@brainstrike/ui';
import { FolderOpen, Loader2 } from 'lucide-react';
import { memo, useCallback, useDeferredValue, useState } from 'react';
import { RootSectionHeader } from '../components/root-section-header';
import { FileTreeProvider, useFileTreeContext } from '../tree/file-tree-provider';
import OptimizedFileTree from '../tree/optimized-file-tree';
import { getRootFolderId } from '../utils/get-root-folder-id';

const NoFilesSelected = () => (
  <EmptyState
    description="Connect a directory to browse your project and select files"
    icon={<FolderOpen />}
    title="No directory selected"
  />
);

/**
 * Loading indicator shown during Select All operations.
 * Uses a subtle overlay with spinner to indicate work in progress
 * without being too intrusive.
 */
const SelectAllLoadingIndicator = () => (
  <div
    className="absolute inset-0 z-30 flex items-center justify-center bg-background/50"
    data-testid="select-all-loading-overlay"
  >
    <div className="flex items-center gap-2 rounded-md bg-background/90 px-3 py-2 shadow-sm">
      <Loader2 className="h-4 w-4 animate-spin text-primary" />
      <span className="text-muted-foreground text-xs">Selecting files...</span>
    </div>
  </div>
);

interface FileExplorerSidebarProps {
  /** Cancel loading for a directory (called on collapse) */
  cancelChildLoading?: ((path: string) => void) | undefined;
  currentFolderId: string | null;
  filterError: Error | null;
  isInitialLoad: boolean;
  isLoading: boolean;
  /** Whether the entire tree is being loaded for select all */
  isLoadingForSelectAll?: boolean | undefined;
  /** Whether a folder is being loaded for selection */
  isLoadingForSelection?: boolean | undefined;
  loadingFiles: Set<string>;
  /** Path of the folder being loaded for selection */
  loadingPathForSelection?: string | null | undefined;
  /** Set of paths currently loading their children (lazy loading) */
  loadingPaths?: Set<string> | undefined;
  /** Callback to load children of a directory on expand (lazy loading) */
  onLoadChildren?: ((path: string) => Promise<void>) | undefined;
  /** Select all files in a folder recursively, loading if needed */
  onSelectFolderRecursively?:
    | ((node: IFileNode) => Promise<{ success: boolean; filePaths: string[] }>)
    | undefined;
  onTreeRender?: (() => void) | undefined;
  quickFilteredTree: IFileNode[] | null;
  rootDirectoryHandle: DirectoryHandle | null;
  /** All active root handles. When length > 1, renders a forest (one tree per root). */
  rootDirectoryHandles?: DirectoryHandle[] | undefined;
  /**
   * Maps handle.path → RootId UUID (storage v5).
   * Used to resolve the durable identity for `OptimizedFileTree`'s `folderId` prop.
   * When absent the sidebar falls back to `getRootFolderId(handle)` (path).
   */
  rootIdByPath?: ReadonlyMap<string, string> | undefined;
  /** Switch focus to the root at the given path (forest mode). */
  setFocusedRoot?: ((path: string) => void) | undefined;
  treeError: Error | null;
}

const ErrorDisplay = ({
  treeError,
  filterError,
}: {
  treeError?: Error | null;
  filterError?: Error | null;
}) => (
  <div
    className="m-2 rounded border border-red-400 bg-red-100 p-3 text-red-700 text-sm dark:border-red-700 dark:bg-red-900 dark:text-red-200"
    role="alert"
  >
    <strong>Error: </strong>
    {treeError?.message}
    {filterError && ` ${filterError.message}`}
  </div>
);

const EmptyStateComponent = ({
  isLoading,
}: {
  isLoading: boolean;
  quickFilteredTree: IFileNode[] | null;
  rootDirectoryHandle: DirectoryHandle | null;
}) => (
  <div className="py-8 text-center text-muted-foreground">
    {isLoading ? 'Loading files...' : 'No matching files found'}
  </div>
);

/**
 * Inner component for a root section's tree content.
 * Must be rendered inside a FileTreeProvider so it can read the per-root tree
 * from context. Any click inside the tree container bubbles to the parent
 * RootSection's onClick handler which switches focus to this root.
 */
interface PerRootTreePaneProps {
  cancelChildLoading?: ((path: string) => void) | undefined;
  currentFolderId: string | null;
  isLoading: boolean;
  isLoadingForSelectAll?: boolean | undefined;
  isLoadingForSelection?: boolean | undefined;
  loadingFiles: Set<string>;
  loadingPathForSelection?: string | null | undefined;
  loadingPaths?: Set<string> | undefined;
  onLoadChildren?: ((path: string) => Promise<void>) | undefined;
  onSelectFolderRecursively?:
    | ((node: IFileNode) => Promise<{ success: boolean; filePaths: string[] }>)
    | undefined;
  onTreeRender?: (() => void) | undefined;
  rootDirectoryHandle: DirectoryHandle;
  /**
   * Durable RootId UUID for this root (storage v5). When provided, used as
   * `folderId` for OptimizedFileTree instead of the handle path.
   */
  rootId?: string | undefined;
}

const PerRootTreePane: React.FC<PerRootTreePaneProps> = ({
  rootDirectoryHandle,
  loadingFiles,
  currentFolderId,
  onTreeRender,
  loadingPaths,
  onLoadChildren,
  cancelChildLoading,
  onSelectFolderRecursively,
  isLoadingForSelection,
  loadingPathForSelection,
  isLoadingForSelectAll = false,
  isLoading: isLoadingProp,
  rootId,
}) => {
  // Reads the real file tree for THIS root from its enclosing FileTreeProvider.
  const treeContext = useFileTreeContext();
  const deferredTree = useDeferredValue(treeContext.fileTree);
  const isLoading = treeContext.isLoading || isLoadingProp;
  const hasContent = deferredTree.length > 0;
  // Storage v5: use durable RootId UUID when available so the folderId
  // matches IFileNode.rootFolderId (linchpin equality).
  const folderId = rootId ?? getRootFolderId(rootDirectoryHandle) ?? currentFolderId ?? '';

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {isLoadingForSelectAll && <SelectAllLoadingIndicator />}
      {hasContent ? (
        <OptimizedFileTree
          cancelChildLoading={cancelChildLoading}
          fileTree={deferredTree}
          folderId={folderId}
          isLoadingForSelection={isLoadingForSelection}
          loadingFiles={loadingFiles}
          loadingPathForSelection={loadingPathForSelection}
          loadingPaths={loadingPaths}
          onLoadChildren={onLoadChildren}
          onRender={onTreeRender || undefined}
          onSelectFolderRecursively={onSelectFolderRecursively}
        />
      ) : (
        <EmptyStateComponent
          isLoading={isLoading}
          quickFilteredTree={deferredTree}
          rootDirectoryHandle={rootDirectoryHandle}
        />
      )}
    </div>
  );
};

/** One collapsible root section (header + tree) used in forest mode.
 *
 * Wraps its content in a dedicated FileTreeProvider so the root runs its own
 * useFileTree and shows its own real directory contents. Row interactions
 * (clicks anywhere inside the tree container) bubble to the section wrapper
 * and call setFocusedRoot — this is the per-root-boundary focus-switch site.
 */
interface RootSectionProps extends PerRootTreePaneProps {
  rootIdByPath?: ReadonlyMap<string, string> | undefined;
  setFocusedRoot?: ((path: string) => void) | undefined;
}

const RootSection: React.FC<RootSectionProps> = ({
  rootDirectoryHandle,
  setFocusedRoot,
  rootIdByPath,
  ...rest
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  // Storage v5: resolve durable RootId for this root's handle path.
  const resolvedRootId = rootIdByPath?.get(rootDirectoryHandle.path);

  const handleToggle = useCallback(() => {
    // Header click: focus this root AND toggle collapse.
    setFocusedRoot?.(rootDirectoryHandle.path);
    setIsCollapsed((v) => !v);
  }, [setFocusedRoot, rootDirectoryHandle.path]);

  const handleTreeInteraction = useCallback(() => {
    // Any interaction inside the tree container (row click, key press, etc.)
    // switches focused root. This is the per-root-boundary wiring site: bubbled
    // clicks from OptimizedFileTree rows reach this handler which is cheaper
    // than wiring into every individual row's dispatch path.
    setFocusedRoot?.(rootDirectoryHandle.path);
  }, [setFocusedRoot, rootDirectoryHandle.path]);

  return (
    <div className="flex flex-col">
      <RootSectionHeader
        displayName={rootDirectoryHandle.name}
        isCollapsed={isCollapsed}
        onToggleCollapse={handleToggle}
      />
      {!isCollapsed && (
        // Each root gets its own FileTreeProvider so it runs its own useFileTree
        // independently — previously all non-focused roots received an empty
        // quickFilteredTree=[]; now each loads and shows its own real content.
        // Keyed by resolvedRootId (UUID) when available — if two roots share the
        // same path but have different UUIDs they get correctly distinct providers.
        // Falls back to handle.path for pre-v5 handles.
        <FileTreeProvider
          key={resolvedRootId ?? rootDirectoryHandle.path}
          rootDirectoryHandle={rootDirectoryHandle}
          {...(resolvedRootId !== undefined && { rootId: resolvedRootId })}
        >
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: tree rows have their own keyboard handlers; this is a focus-switch affordance only */}
          {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: intentional event-bubbling capture boundary for focus-switch */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: intentional event-bubbling capture boundary for focus-switch */}
          <div onClick={handleTreeInteraction}>
            <PerRootTreePane
              rootDirectoryHandle={rootDirectoryHandle}
              rootId={resolvedRootId}
              {...rest}
            />
          </div>
        </FileTreeProvider>
      )}
    </div>
  );
};

const FileExplorerSidebar: React.FC<FileExplorerSidebarProps> = memo(
  ({
    rootDirectoryHandle,
    rootDirectoryHandles,
    rootIdByPath,
    setFocusedRoot,
    treeError,
    filterError,
    quickFilteredTree,
    loadingFiles,
    isLoading,
    isInitialLoad,
    currentFolderId,
    onTreeRender,
    loadingPaths,
    onLoadChildren,
    cancelChildLoading,
    onSelectFolderRecursively,
    isLoadingForSelection,
    loadingPathForSelection,
    isLoadingForSelectAll = false,
  }) => {
    // React 19: useDeferredValue keeps showing the old tree while new one renders
    // This prevents "flash" during rapid tree updates (like expand-all)
    const deferredTree = useDeferredValue(quickFilteredTree);

    const showError = (treeError || filterError) && !isLoading && !isInitialLoad;

    // FOREST MODE: render one collapsible section per root when multiple roots are active.
    // When rootDirectoryHandles.length <= 1, fall through to the original single-tree layout.
    const forestHandles = rootDirectoryHandles ?? [];
    const isForestMode = forestHandles.length > 1;

    if (isForestMode) {
      // Each RootSection has its own FileTreeProvider internally — no quickFilteredTree
      // is passed per-section here (each section derives its tree from its provider).
      const sharedProps = {
        cancelChildLoading,
        currentFolderId,
        isLoading,
        isLoadingForSelection,
        isLoadingForSelectAll,
        loadingFiles,
        loadingPathForSelection,
        loadingPaths,
        onLoadChildren,
        onSelectFolderRecursively,
        onTreeRender,
      };

      return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-linear-to-b from-[#fdfcfb] to-[#f2f0ef] dark:from-[#1a1816] dark:to-[#0a0a0a]">
          {showError && <ErrorDisplay filterError={filterError} treeError={treeError} />}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {forestHandles.map((handle) => (
              <RootSection
                key={rootIdByPath?.get(handle.path) ?? handle.path}
                rootDirectoryHandle={handle}
                rootIdByPath={rootIdByPath}
                setFocusedRoot={setFocusedRoot}
                {...sharedProps}
              />
            ))}
          </div>
        </div>
      );
    }

    // SINGLE-ROOT LAYOUT (original, golden-path regression safety)
    const hasContent = deferredTree && deferredTree.length > 0;
    // Storage v5: resolve RootId for single-root mode folderId.
    const singleRootFolderId =
      (rootDirectoryHandle && rootIdByPath?.get(rootDirectoryHandle.path)) ??
      getRootFolderId(rootDirectoryHandle) ??
      currentFolderId ??
      '';

    return (
      <div className="flex h-full w-full flex-col overflow-hidden bg-linear-to-b from-[#fdfcfb] to-[#f2f0ef] dark:from-[#1a1816] dark:to-[#0a0a0a]">
        {showError && <ErrorDisplay filterError={filterError} treeError={treeError} />}
        {rootDirectoryHandle ? (
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Subtle loading overlay during Select All operation */}
            {isLoadingForSelectAll && <SelectAllLoadingIndicator />}
            {hasContent ? (
              <OptimizedFileTree
                cancelChildLoading={cancelChildLoading}
                fileTree={deferredTree}
                folderId={singleRootFolderId}
                isLoadingForSelection={isLoadingForSelection}
                loadingFiles={loadingFiles}
                loadingPathForSelection={loadingPathForSelection}
                loadingPaths={loadingPaths}
                onLoadChildren={onLoadChildren}
                onRender={onTreeRender || undefined}
                onSelectFolderRecursively={onSelectFolderRecursively}
              />
            ) : (
              <EmptyStateComponent
                isLoading={isLoading}
                quickFilteredTree={deferredTree}
                rootDirectoryHandle={rootDirectoryHandle}
              />
            )}
          </div>
        ) : (
          <div className="flex-1">
            <NoFilesSelected />
          </div>
        )}
      </div>
    );
  }
);

export default FileExplorerSidebar;
