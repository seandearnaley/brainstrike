import type { AnyContextAction } from '@brainstrike/context-actions';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import { type ContextMenuTargetController, useContextMenuTarget } from '@brainstrike/ui';
import { type RefObject, useCallback, useMemo, useRef, useState } from 'react';
import { buildWorkspaceRootLocalActions } from '../context-actions/workspace-root-local-actions';
import { workspaceRootToTarget } from '../context-actions/workspace-root-target';
import { getRootFolderId } from '../utils/get-root-folder-id';
import { useFileExplorerStoreSelector } from './file-explorer-provider';

const logger = createLogger('FileExplorerSidebar');

export interface UseRootSectionContextMenuOptions {
  /** The root's display name (a web FSA handle's `path` IS this value). */
  readonly displayName: string;
  /**
   * True while a destructive dialog this menu staged (Disconnect…) is open.
   * `onCloseAutoFocus` skips its own restoration while this is true — the
   * dialog's `FocusScope` owns focus, and stealing it back would fight the
   * dialog rather than the menu.
   */
  readonly isDisconnectDialogOpen: boolean;
  readonly isMain: boolean;
  /**
   * Present only when this surface can actually disconnect the root (mirrors
   * the header's own X button, `onRemoveRoot ? handleDisconnectRequest :
   * undefined`). Absent ⇒ Disconnect… is omitted from the menu, not
   * disabled — an unconditionally-visible Disconnect… that silently does
   * nothing is the AGENTS.md silent-fallback shape.
   */
  readonly onDisconnect?: (() => void) | undefined;
  /**
   * Already-normalized: `null` when the root has no absolute path distinct
   * from its display name (a web FSA handle, whose `path` IS its `name` —
   * `packages/types/src/file-system.ts`). Callers hoist this ONE comparison
   * once and reuse it for both the claimed target and any path-shaped UI
   * (e.g. the header's tooltip `path` prop) — see `workspaceRootToTarget`,
   * which keeps its own copy of this same normalization as a defensive
   * backstop for callers that don't.
   */
  readonly path: string | null;
  /**
   * Where to land focus when the menu closes (Radix's own trigger-focus
   * restoration is suppressed by supplying `onCloseAutoFocus` at all, so it
   * must go somewhere real — never `document.body`). A forwarded ref to a
   * focusable DOM node; a miss is logged, never silent.
   */
  readonly restoreFocusRef: RefObject<HTMLElement | null>;
  /**
   * Host-composed actions (Open in Terminal, New thread here) injected
   * alongside the local ones — see `FileExplorerPanelProps.rootActions`.
   */
  readonly rootActions?: readonly AnyContextAction[] | undefined;
  readonly rootId: string;
}

export interface UseRootSectionContextMenuResult {
  /** Claims this row's `workspace-root` ContextTarget. Wire to `onContextMenu`. */
  readonly claim: () => void;
  readonly controller: ContextMenuTargetController;
  readonly localActions: readonly AnyContextAction[];
  /** Wire to `ActionContextMenu`'s `onCloseAutoFocus`. */
  readonly onCloseAutoFocus: () => void;
  /** Clears the claimed target. Wire to `onContextMenuCapture` on the trigger's reset boundary. */
  readonly reset: () => void;
}

/**
 * The `workspace-root` context-menu wiring shared by every surface that can
 * trigger it — today the forest sidebar's `RootSectionHeader` and the
 * single-root layout's own header row (BST-1393). Centralizing this avoids
 * two independently-maintained copies of the claim/reset/local-actions/focus-
 * restoration protocol drifting apart, which is exactly the failure class
 * that let the single-root branch ship with NO menu trigger at all in the
 * primary (one-folder) scenario — a gap only the forest branch's copy would
 * have caught in review.
 */
export function useRootSectionContextMenu({
  displayName,
  isDisconnectDialogOpen,
  isMain,
  onDisconnect,
  path,
  restoreFocusRef,
  rootActions,
  rootId,
}: UseRootSectionContextMenuOptions): UseRootSectionContextMenuResult {
  const activeRootIds = useFileExplorerStoreSelector((s) => s.activeRootIds);
  const setMainRoot = useFileExplorerStoreSelector((s) => s.setMainRoot);
  const controller = useContextMenuTarget();
  const { setTarget } = controller;

  const claim = useCallback(() => {
    setTarget(
      workspaceRootToTarget({
        displayName,
        isMain,
        ...(path === null ? {} : { path }),
        rootId,
      })
    );
  }, [displayName, isMain, path, rootId, setTarget]);

  const reset = useCallback(() => {
    setTarget(null);
  }, [setTarget]);

  const localActions = useMemo<readonly AnyContextAction[]>(
    () => [
      ...buildWorkspaceRootLocalActions({
        ...(onDisconnect ? { onDisconnect } : {}),
        onSetAsMain: (target) => {
          // `setMainRoot` warn-and-no-ops for an id `activeRootIds` doesn't
          // recognize (a legacy path-identity root — `RootSection`'s
          // `rootIdentity` fallback can still produce one). Check first so
          // the menu can toast instead of silently doing nothing.
          if (!activeRootIds.includes(target.rootId)) {
            return {
              error: 'Cannot set Main: this root has no durable id.',
              ok: false,
            };
          }
          setMainRoot(target.rootId);
          return { ok: true };
        },
      }),
      ...(rootActions ?? []),
    ],
    [activeRootIds, onDisconnect, rootActions, setMainRoot]
  );

  const onCloseAutoFocus = useCallback(() => {
    if (isDisconnectDialogOpen) {
      // The staged Disconnect… dialog owns focus (its own FocusScope);
      // restoring here would fight it rather than the menu it closed.
      return;
    }
    const target = restoreFocusRef.current;
    if (!target) {
      logger.error(
        'onCloseAutoFocus: restore-focus target ref is unset; focus restoration failed',
        { rootId }
      );
      return;
    }
    target.focus();
  }, [isDisconnectDialogOpen, restoreFocusRef, rootId]);

  return { claim, controller, localActions, onCloseAutoFocus, reset };
}

export interface UseSingleRootHeaderMenuOptions {
  /** Client-declared main root (`activeRootIds[0]`) — badges the primary root. */
  readonly mainRootId: string | undefined;
  readonly onRemoveRoot?:
    | ((rootId: string, options?: { deleteData?: boolean }) => Promise<void>)
    | undefined;
  readonly rootActions?: readonly AnyContextAction[] | undefined;
  readonly rootDirectoryHandle: DirectoryHandle | null;
  readonly rootIdByPath?: ReadonlyMap<string, string> | undefined;
}

export interface UseSingleRootHeaderMenuResult {
  readonly claim: () => void;
  readonly controller: ContextMenuTargetController;
  readonly isDisconnectDialogOpen: boolean;
  readonly localActions: readonly AnyContextAction[];
  readonly onCloseAutoFocus: () => void;
  readonly onDisconnectConfirm: (options: { deleteData: boolean }) => void;
  readonly reset: () => void;
  readonly restoreFocusRef: RefObject<HTMLDivElement | null>;
  readonly rootIdentity: string;
  readonly setIsDisconnectDialogOpen: (open: boolean) => void;
}

/**
 * `useRootSectionContextMenu`, specialized for the single-root layout
 * (BST-1393 review fold-in): that branch has no `RootSectionHeader` at all,
 * so it owns its own disconnect-dialog state and identity resolution rather
 * than reusing `RootSectionInner`'s (forest-only) copies. Extracted into its
 * own hook — rather than inlined in `FileExplorerSidebar` — to keep that
 * already-large component under the cognitive-complexity ceiling (Biome
 * `noExcessiveCognitiveComplexity`), per the plan's pre-authorized
 * extraction remedy.
 */
export function useSingleRootHeaderMenu({
  mainRootId,
  onRemoveRoot,
  rootActions,
  rootDirectoryHandle,
  rootIdByPath,
}: UseSingleRootHeaderMenuOptions): UseSingleRootHeaderMenuResult {
  const [isDisconnectDialogOpen, setIsDisconnectDialogOpen] = useState(false);
  // Same identity resolution as RootSection's `rootIdentity` (storage v5:
  // stamped rootId, then the path→id map, then the path) — never
  // `currentFolderId`, which is FOCUS state, not root identity.
  const rootIdentity = getRootFolderId(rootDirectoryHandle, rootIdByPath) ?? '';
  // A web FSA handle's `path` IS its `name` — same hoisted normalization
  // `RootSectionInner` uses for its own `rootPath`.
  const path =
    rootDirectoryHandle?.path && rootDirectoryHandle.path !== rootDirectoryHandle.name
      ? rootDirectoryHandle.path
      : null;

  const handleDisconnectRequest = useCallback(() => {
    setIsDisconnectDialogOpen(true);
  }, []);

  const onDisconnectConfirm = useCallback(
    (options: { deleteData: boolean }) => {
      setIsDisconnectDialogOpen(false);
      // Fire-and-forget is safe here for the same reason RootSectionInner's
      // handleDisconnectConfirm is: removeRootDirectory catches every
      // failure path internally and surfaces a toast instead of rejecting.
      void onRemoveRoot?.(rootIdentity, options);
    },
    [onRemoveRoot, rootIdentity]
  );

  const restoreFocusRef = useRef<HTMLDivElement | null>(null);

  const { claim, controller, localActions, onCloseAutoFocus, reset } = useRootSectionContextMenu({
    displayName: rootDirectoryHandle?.name ?? '',
    isDisconnectDialogOpen,
    isMain: mainRootId !== undefined && mainRootId === rootIdentity,
    ...(onRemoveRoot ? { onDisconnect: handleDisconnectRequest } : {}),
    path,
    restoreFocusRef,
    rootActions,
    rootId: rootIdentity,
  });

  return {
    claim,
    controller,
    isDisconnectDialogOpen,
    localActions,
    onCloseAutoFocus,
    onDisconnectConfirm,
    reset,
    restoreFocusRef,
    rootIdentity,
    setIsDisconnectDialogOpen,
  };
}
