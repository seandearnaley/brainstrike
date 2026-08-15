import type { ReactElement } from 'react';
import { FileTabBody } from './file-tab-body';
import { useWorkspaceTabs } from './use-workspace-tabs';
import { WorkspaceLauncher } from './workspace-launcher';
import { getTabRootPath } from './workspace-tab-utils';

/**
 * The workspace panel's content area (BST-1258). Renders:
 *
 * - every MOUNTED app surface, hidden unless active — the keep-alive contract:
 *   an app activated once this session never unmounts (Canvas's sandboxed
 *   iframe must not reload; the explorer layout keeps its panel/scroll state);
 * - the ACTIVE file tab's body (file bodies render one at a time, keyed by
 *   compositeKey, exactly as before);
 * - the launcher empty state when nothing resolvable is selected.
 *
 * `app.render()` is invoked inline on every re-render per the WorkspaceApp
 * contract (cheap + idempotent; React reconciles the same element type, so
 * stable component identity inside render() avoids remounts).
 */
export function WorkspaceBody(): ReactElement {
  const {
    apps,
    fileContents,
    isRestoring,
    loadingFiles,
    mountedAppIds,
    rootDescriptors,
    selection,
    tabs,
    tabStatuses,
  } = useWorkspaceTabs();

  const activeFileTab =
    selection.kind === 'file' ? tabs.find((t) => t.id === selection.tabId) : undefined;
  const activeAppIsRegistered =
    selection.kind === 'app' && apps.some((app) => app.id === selection.appId);
  // The dead-selection effect in the provider routes unresolvable selections to
  // an open app or the empty state; the launcher covers the transient frame too.
  const showLauncher =
    selection.kind === 'empty' ||
    (selection.kind === 'file' && !activeFileTab) ||
    (selection.kind === 'app' && !activeAppIsRegistered);

  return (
    <div className="h-full min-h-0 bg-background" data-testid="workspace-body">
      {apps
        .filter((app) => mountedAppIds.has(app.id))
        .map((app) => {
          const isActiveApp = selection.kind === 'app' && selection.appId === app.id;
          return (
            <div
              aria-labelledby={`workspace-app-tab-${app.id}`}
              className="h-full"
              hidden={!isActiveApp}
              id={`workspace-app-panel-${app.id}`}
              key={app.id}
              role="tabpanel"
            >
              {app.render()}
            </div>
          );
        })}
      {activeFileTab ? (
        <div
          aria-labelledby={`workspace-file-tab-${activeFileTab.id}`}
          className="h-full"
          id={`workspace-file-panel-${activeFileTab.id}`}
          role="tabpanel"
        >
          <FileTabBody
            content={fileContents[activeFileTab.compositeKey]}
            isLoading={loadingFiles.has(activeFileTab.compositeKey)}
            isRestoring={isRestoring}
            key={activeFileTab.compositeKey}
            rootPath={getTabRootPath(activeFileTab, rootDescriptors)}
            status={tabStatuses.get(activeFileTab.compositeKey)}
            tab={activeFileTab}
          />
        </div>
      ) : null}
      {showLauncher ? <WorkspaceLauncher /> : null}
    </div>
  );
}
