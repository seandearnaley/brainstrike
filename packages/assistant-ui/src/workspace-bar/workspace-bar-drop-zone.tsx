import { cn } from '@brainstrike/ui';
import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
import { useComposerTakesImageDrops, yieldsToComposerImageDrop } from '../composer-image-drop';

/**
 * True when a drag originates from the OS and carries files/folders.
 * Internal drags (assistant-thread tabs via pragmatic-drag-and-drop, text
 * selections) advertise other types and must not arm or consume this drop
 * zone. Checked BEFORE `preventDefault()` so an internal drag passes through
 * untouched. The `'Files'` MIME gate is the security-relevant part: it keeps
 * an internal pragmatic-drag-and-drop thread-tab drag from being consumed.
 */
function dragCarriesFiles(event: React.DragEvent<HTMLElement>): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes('Files') : false;
}

export interface WorkspaceBarDropZoneProps {
  readonly children: ReactNode;
  readonly onDropItems: (items: readonly DataTransferItem[]) => void;
}

/**
 * The composer's Finder-folder drop surface (BST-1393, Task 12). Wraps the
 * bar's chips when — and only when — the platform can resolve a dropped
 * folder to a path; app-shell's `useFolderDrop` decides that.
 *
 * The ring guard on drag-leave uses `relatedTarget` rather than a
 * `currentTarget === target` check: the bar is full of chips, and a dragleave
 * bubbling off any one of them would flicker the ring. `relatedTarget` names where the pointer actually
 * went, so a move onto a still-contained chip is not a leave.
 *
 * A drag of images only, where the composer attaches images, is not a folder
 * drop: it passes through untouched to the composer shell around the bar,
 * which attaches the images (or says why the model cannot take them).
 */
export function WorkspaceBarDropZone({
  children,
  onDropItems,
}: WorkspaceBarDropZoneProps): ReactElement {
  const [isDragOver, setIsDragOver] = useState(false);
  const composerTakesImages = useComposerTakesImageDrops();

  const handleDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (yieldsToComposerImageDrop(composerTakesImages, event.dataTransfer)) {
      setIsDragOver(false);
      return;
    }
    if (!dragCarriesFiles(event)) {
      return;
    }
    event.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLElement>) => {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) {
      return;
    }
    setIsDragOver(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLElement>) => {
    if (
      !dragCarriesFiles(event) ||
      yieldsToComposerImageDrop(composerTakesImages, event.dataTransfer)
    ) {
      // Internal drags (thread tabs, text selections) pass through
      // untouched; this surface only mounts real OS folders.
      setIsDragOver(false);
      return;
    }
    event.preventDefault();
    setIsDragOver(false);
    onDropItems(Array.from(event.dataTransfer.items));
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: drag-and-drop mount surface; the keyboard-accessible path is the Folder chip's Add folder… action.
    // biome-ignore lint/a11y/noStaticElementInteractions: deliberately a bare <div>, NOT a labelled <section> — workspace-bar.tsx:251-253 documents that this exact bar rejects an extra grouping level (each chip already carries its own accessible name), and this wrapper exists only to catch a pointer gesture AT users cannot perform anyway. A <section aria-label> here would add the permanent landmark-list noise that comment argues against, for a surface AT users never reach.
    <div
      className={cn('bs-composer-workspace-drop', isDragOver && 'ring-primary ring-2 ring-inset')}
      data-testid="workspace-bar-drop-zone"
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
    </div>
  );
}

WorkspaceBarDropZone.displayName = 'WorkspaceBarDropZone';
