import type { TargetOf } from '@brainstrike/context-actions';
import {
  type CodeSurfaceContextMenuSelection,
  type ContextMenuTargetController,
  useContextMenuTarget,
} from '@brainstrike/ui';
import type { MarkdownSurfaceContextMenuSelection } from '@brainstrike/ui/markdown-surface';
import { createLogger } from '@brainstrike/utils';
import { useCallback } from 'react';
import { type FileSurfaceTab, fileViewerToTarget } from './file-surface-target';

const logger = createLogger('FileViewerContextMenu');

interface UseFileViewerContextMenuOptions {
  readonly rootPath: string | null;
  readonly tab: FileSurfaceTab;
  readonly viewMode: TargetOf<'file-viewer'>['viewMode'];
}

interface FileViewerContextMenuBindings {
  readonly controller: ContextMenuTargetController;
  readonly handleCodeContextMenuSelection: (selection: CodeSurfaceContextMenuSelection) => void;
  readonly handleMarkdownContextMenuSelection: (
    selection: MarkdownSurfaceContextMenuSelection
  ) => void;
  readonly handleViewerContextMenu: () => void;
  readonly resetContextMenuTarget: () => void;
}

export function useFileViewerContextMenu({
  rootPath,
  tab,
  viewMode,
}: UseFileViewerContextMenuOptions): FileViewerContextMenuBindings {
  const controller = useContextMenuTarget();
  const { setTarget, targetRef } = controller;

  const claimViewerContext = useCallback(
    (
      selectionText: string | null,
      sourceRange: { readonly from: number; readonly to: number } | null
    ): void => {
      const target = fileViewerToTarget(tab, rootPath, {
        selectionText,
        sourceRange,
        viewMode,
      });
      if (!target) {
        logger.error('Could not resolve file viewer context target', {
          compositeKey: tab.compositeKey,
        });
        setTarget(null);
        return;
      }
      setTarget(target);
    },
    [rootPath, setTarget, tab, viewMode]
  );

  const handleCodeContextMenuSelection = useCallback(
    (selection: CodeSurfaceContextMenuSelection): void => {
      claimViewerContext(selection.text, { from: selection.from, to: selection.to });
    },
    [claimViewerContext]
  );

  const handleMarkdownContextMenuSelection = useCallback(
    (selection: MarkdownSurfaceContextMenuSelection): void => {
      claimViewerContext(selection.text, null);
    },
    [claimViewerContext]
  );

  const handleViewerContextMenu = useCallback((): void => {
    // CodeSurface/MarkdownSurface claim an exact semantic selection first.
    // Header/loading-state right-clicks get file-level actions without reusing
    // a selection from an earlier invocation.
    if (targetRef.current === null) {
      claimViewerContext(null, null);
    }
  }, [claimViewerContext, targetRef]);

  const resetContextMenuTarget = useCallback((): void => {
    setTarget(null);
  }, [setTarget]);

  return {
    controller,
    handleCodeContextMenuSelection,
    handleMarkdownContextMenuSelection,
    handleViewerContextMenu,
    resetContextMenuTarget,
  };
}
