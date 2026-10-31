import type { WorkspaceApp } from '@brainstrike/file-explorer-ui/shell';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { PanelsTopLeft } from 'lucide-react';
import { useMemo } from 'react';
import { CanvasDocumentView } from './canvas-document-view';
import { type CanvasWorkspaceTab, readCanvasWorkspaceTab } from './canvas-workspace-tab';
import { openCanvasTab } from './open-canvas-tab';
import { useThreadCanvasReads } from './use-thread-canvas-reads';

const icon: WorkspaceApp['icon'] = ({ className }) => <PanelsTopLeft className={className} />;
const FALLBACK_LABEL = 'Canvas';

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Every open canvas is a dynamic workspace tab of its own, so several canvases
 * show side by side and each keeps its own version (BST-1173). A tab is named
 * after its canvas's latest title once its thread has been read. `shellSrc` is
 * absent on a host without the canvas shell, which then registers no canvas
 * tab at all.
 */
export function useCanvasWorkspaceApps(shellSrc: string | undefined): readonly WorkspaceApp[] {
  const openIds = useWorkspaceTabSelectionStore((state) => state.openAppIds);
  const addresses = useMemo(
    () =>
      shellSrc === undefined
        ? []
        : openIds.flatMap(
            (id): { readonly id: string; readonly tab: CanvasWorkspaceTab | Error }[] => {
              try {
                const tab = readCanvasWorkspaceTab(id);
                return tab ? [{ id, tab }] : [];
              } catch (error) {
                return [{ id, tab: asError(error) }];
              }
            }
          ),
    [openIds, shellSrc]
  );
  const reads = useThreadCanvasReads(
    addresses.flatMap(({ tab }) => (tab instanceof Error ? [] : [tab.threadId]))
  );
  return addresses.map(({ id, tab }): WorkspaceApp => {
    if (tab instanceof Error || shellSrc === undefined) {
      const message = tab instanceof Error ? tab.message : 'Canvases are unavailable.';
      return {
        icon,
        id,
        label: FALLBACK_LABEL,
        placement: 'dynamic',
        render: () => (
          <p className="text-destructive p-4 text-xs" role="alert">
            {message}
          </p>
        ),
      };
    }
    const read = reads.get(tab.threadId);
    const title =
      read?.status === 'ready' ? read.canvases.get(tab.canvasId)?.at(-1)?.title : undefined;
    return {
      icon,
      id,
      label: title?.trim() || FALLBACK_LABEL,
      placement: 'dynamic',
      render: () => <CanvasDocumentView read={read} shellSrc={shellSrc} tab={tab} />,
      // A closed canvas tab leaves this registry, so Reopen Closed Tab opens it again here.
      reopen: () => {
        openCanvasTab(tab);
        return Promise.resolve();
      },
    };
  });
}
