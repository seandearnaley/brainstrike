/**
 * Selection Manager Hook (Context-aware)
 *
 * This hook manages file selection state and enforces selection limits.
 * It uses the context-based store instead of the global store.
 *
 * Supports two selection modes:
 * - 'explicit': Traditional manual file selection
 * - 'rules': Rule-based selection using materialized paths
 */

import { getForeignSelectionCount } from '@brainstrike/file-explorer';
import { useSelectionManager as useCoreSelectionManager } from '@brainstrike/file-explorer-hooks';
import type { FolderState } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useCallback, useMemo } from 'react';
import { useSelectionResolver } from '../use-selection-resolver';
import { useFileExplorerStoreSelector } from './file-explorer-provider';

/**
 * Union the focused root's LIVE selection (the top-level set) with every
 * OTHER active root's persisted folderState selection (Phase 6 cross-root).
 * The focused root's folderState is a stale snapshot while focused and is
 * deliberately excluded. Returns the top-level set UNCHANGED when no other
 * root contributes — memo identity matters to downstream consumers.
 */
function unionSelectionAcrossRoots(
  selectedFilePaths: Set<string>,
  activeRootIds: readonly string[],
  currentFolderId: string | null,
  folderStates: Record<string, FolderState>
): Set<string> {
  let union: Set<string> | null = null;
  for (const rootId of activeRootIds) {
    if (rootId === currentFolderId) {
      continue;
    }
    const rootSelection = folderStates[rootId]?.selectedFilePaths;
    if (!rootSelection || rootSelection.size === 0) {
      continue;
    }
    union ??= new Set(selectedFilePaths);
    for (const key of rootSelection) {
      union.add(key);
    }
  }
  return union ?? selectedFilePaths;
}

/**
 * Partition a write-back list by the composite key's rootId. Focused-root
 * keys and legacy (separator-less) keys belong to the core selection manager;
 * every other ACTIVE root's keys are bucketed for setFolderSelection. A key
 * carrying the rootId of an INACTIVE root (e.g. one lingering from a just-
 * disconnected root) is DROPPED rather than mis-filed into the focused root's
 * top-level set under a foreign identity.
 */
function partitionSelectionByRoot(
  list: readonly string[],
  currentFolderId: string | null,
  activeRootIds: readonly string[]
): { focusedKeys: Set<string>; byOtherRoot: Map<string, string[]> } {
  const focusedKeys = new Set<string>();
  const byOtherRoot = new Map<string, string[]>();
  for (const key of list) {
    const rootId = key.includes('|@|') ? key.split('|@|')[0] : undefined;
    if (rootId && rootId !== currentFolderId) {
      // Foreign-root key: bucket it for its root only if that root is still
      // active; otherwise drop it (a stale key must not be re-attributed to
      // the focused root).
      if (activeRootIds.includes(rootId)) {
        const bucket = byOtherRoot.get(rootId) ?? [];
        bucket.push(key);
        byOtherRoot.set(rootId, bucket);
      }
    } else {
      // Focused-root key (rootId === currentFolderId) or a legacy
      // separator-less key — both belong to the core selection manager.
      focusedKeys.add(key);
    }
  }
  return { focusedKeys, byOtherRoot };
}

export const useSelectionManager = () => {
  const [
    selectedFilePaths,
    maxSelectionCount,
    setSelectedFiles,
    selectionModel,
    currentFolderId,
    clearSelectionRules,
  ] = useFileExplorerStoreSelector(
    (s) =>
      [
        s.selectedFilePaths,
        s.maxSelectionCount,
        s.setSelectedFiles,
        s.selectionModel,
        s.currentFolderId,
        s.clearSelectionRules,
      ] as const
  );
  const {
    effectiveSelection: resolvedSelection,
    isQuerySelectionReady,
    selectedCount: resolvedSelectedCount,
    selectedFilesList: resolvedSelectedFilesList,
  } = useSelectionResolver();
  // Multi-root union inputs (Phase 6). The focused root's live selection is
  // the TOP-LEVEL set; its folderState is a stale snapshot until focus leaves
  // it, so the union reads folderStates only for the OTHER active roots.
  const activeRootIds = useFileExplorerStoreSelector((s) => s.activeRootIds);
  const folderStates = useFileExplorerStoreSelector((s) => s.folderStates);
  const setFolderSelection = useFileExplorerStoreSelector((s) => s.setFolderSelection);

  const setSelectedFilesStable = useCallback(
    (next: ReadonlySet<string>) => {
      setSelectedFiles(new Set(Array.from(next)));
    },
    [setSelectedFiles]
  );

  // Pass stable state view and setter to the core hook
  const core = useCoreSelectionManager({
    selectedFilePaths,
    maxSelectionCount,
    setSelectedFiles: setSelectedFilesStable,
  });

  /**
   * Effective selection based on current mode.
   *
   * In 'explicit' mode: Returns selectedFilePaths (composite keys)
   * In 'rules' mode: Converts materializedPaths to composite keys
   */
  const effectiveSelection = useMemo(() => {
    if (selectionModel.mode === 'query') {
      return resolvedSelection;
    }
    if (selectionModel.mode === 'rules' && selectionModel.materializedPaths && currentFolderId) {
      // Convert materialized paths (relative) to composite keys
      const compositeKeys = new Set<string>();
      for (const relativePath of selectionModel.materializedPaths) {
        compositeKeys.add(encodeFileSelection(currentFolderId, relativePath));
      }
      return compositeKeys;
    }
    // Explicit mode: cross-root union (Phase 6) — see unionSelectionAcrossRoots.
    return unionSelectionAcrossRoots(
      selectedFilePaths,
      activeRootIds,
      currentFolderId,
      folderStates
    );
  }, [
    activeRootIds,
    currentFolderId,
    folderStates,
    resolvedSelection,
    selectedFilePaths,
    selectionModel.materializedPaths,
    selectionModel.mode,
  ]);

  // Array façade for UI - uses effective selection
  const selectedFilesList = useMemo(
    () =>
      selectionModel.mode === 'query' ? resolvedSelectedFilesList : Array.from(effectiveSelection),
    [effectiveSelection, resolvedSelectedFilesList, selectionModel.mode]
  );

  const selectedCount = useMemo(() => {
    // The count is ALWAYS the whole-forest union — other active roots'
    // folderState selections count regardless of the focused root's mode.
    const foreignCount = getForeignSelectionCount({
      activeRootIds,
      currentFolderId,
      folderStates,
    });
    if (selectionModel.mode === 'query') {
      return resolvedSelectedCount + foreignCount;
    }
    if (selectionModel.mode === 'rules' && selectionModel.materializedPaths) {
      return selectionModel.materializedPaths.size + foreignCount;
    }
    return effectiveSelection.size;
  }, [
    activeRootIds,
    currentFolderId,
    effectiveSelection.size,
    folderStates,
    resolvedSelectedCount,
    selectionModel.materializedPaths,
    selectionModel.mode,
  ]);

  const setSelectedFilesFromList = useCallback(
    (list: readonly string[]) => {
      // When clearing all selections (Deselect All) in rules mode,
      // also clear the rules and switch back to explicit mode.
      // This provides intuitive UX: "Deselect All" means "start fresh".
      if (list.length === 0 && selectionModel.mode === 'rules') {
        clearSelectionRules();
        return;
      }

      // Phase 6 cross-root partition: keys belonging to OTHER active roots
      // must not funnel into the focused top-level set — route each root's
      // subset to its folderState. Roots that had a selection in the union
      // but have NO keys left in `list` are cleared.
      const { focusedKeys, byOtherRoot } = partitionSelectionByRoot(
        list,
        currentFolderId,
        activeRootIds
      );
      for (const rootId of activeRootIds) {
        if (rootId === currentFolderId) {
          continue;
        }
        const next = byOtherRoot.get(rootId);
        const hadSelection = (folderStates[rootId]?.selectedFilePaths.size ?? 0) > 0;
        if (next) {
          setFolderSelection(rootId, next);
        } else if (hadSelection) {
          setFolderSelection(rootId, []);
        }
      }
      core.handleSelectionChange(focusedKeys);
    },
    [
      activeRootIds,
      core.handleSelectionChange,
      currentFolderId,
      folderStates,
      selectionModel.mode,
      clearSelectionRules,
      setFolderSelection,
    ]
  );

  return {
    ...core,
    selectedFilePaths: effectiveSelection,
    selectedCount,
    selectedFilesList,
    setSelectedFilesFromList,
    /** The effective selection set based on current mode */
    effectiveSelection,
    /** Whether we're in rules mode */
    isRulesMode: selectionModel.mode === 'rules',
    /** Whether we're in query-backed large selection mode */
    isQueryMode: selectionModel.mode === 'query',
    isQuerySelectionReady,
  };
};
