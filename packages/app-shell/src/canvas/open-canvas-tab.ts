import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { type CanvasWorkspaceTab, canvasWorkspaceTabId } from './canvas-workspace-tab';

/** Opens the canvas's own workspace tab, or focuses it when it is already open. */
export function openCanvasTab(tab: CanvasWorkspaceTab): void {
  useWorkspaceTabSelectionStore.getState().openApp(canvasWorkspaceTabId(tab));
}
