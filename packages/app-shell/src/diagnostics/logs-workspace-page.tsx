import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import {
  LOGS_APP_ID,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { LogsPage, type LogsPageProps } from '@brainstrike/settings-ui/settings/system/logs-page';

export type LogsWorkspacePageProps = Omit<LogsPageProps, 'active'>;

/**
 * The Logs tab's page. A hidden workspace tab, and the explorer route behind
 * another rail tab, both stay mounted, so it reads its sources only while shown.
 */
export function LogsWorkspacePage(props: LogsWorkspacePageProps) {
  const selected = useWorkspaceTabSelectionStore(
    (state) => state.selection.kind === 'app' && state.selection.appId === LOGS_APP_ID
  );
  const onExplorerRoute = usePanelLayoutStore((state) => state.activeTab === 'explorer');
  return <LogsPage {...props} active={selected && onExplorerRoute} />;
}
