import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import {
  LOGS_APP_ID,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';

/** Shows the Logs workspace tab, for Settings' "Open Logs" and any other entry point. */
export function openLogsTab(): void {
  // The workspace panel exists only on the `explorer` route.
  usePanelLayoutStore.getState().setActiveTab('explorer');
  useWorkspaceTabSelectionStore.getState().openApp(LOGS_APP_ID);
}
