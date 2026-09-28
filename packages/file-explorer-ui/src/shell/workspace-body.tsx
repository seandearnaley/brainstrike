import { TabPanelBoundary } from '@brainstrike/ui';
import type { ReactElement } from 'react';
import { FileTabBody } from './file-tab-body';
import { useWorkspaceTabs } from './use-workspace-tabs';
import { WorkspaceLauncher } from './workspace-launcher';
import { getFileName, getTabRootPath } from './workspace-tab-utils';

/**
 * The workspace panel's content area (BST-1258). Renders:
 *
 * - every OPEN + MOUNTED app surface, hidden unless active — the keep-alive
 *   contract holds across tab switches (Canvas's sandboxed iframe must not
 *   reload; the explorer layout keeps its panel/scroll state), while CLOSING a
 *   tab unmounts the surface so close actually releases it;
 * - the ACTIVE file tab's body (file bodies render one at a time, keyed by
 *   compositeKey, exactly as before);
 * - the launcher empty state when nothing resolvable is selected.
 *
 * Every app panel and the file body sit inside a `TabPanelBoundary`, so a
 * render crash stays in its panel while the strip and other apps keep
 * working. The file body's reset key is the compositeKey: switching files
 * clears a caught crash; an app's is its id (it stays crashed across tab
 * switches until "Reload tab").
 *
 * `app.render()` is invoked inline on every re-render per the WorkspaceApp
 * contract (cheap + idempotent; React reconciles the same element type, so
 * stable component identity inside render() avoids remounts).
 */
export function WorkspaceBody(): ReactElement {
  const {
    apps,
    fileContentErrors,
    fileContents,
    isRestoring,
    loadingFiles,
    mountedAppIds,
    openApps,
    onRetryFileContent,
    rootDescriptors,
    selection,
    tabs,
    tabStatuses,
  } = useWorkspaceTabs();

  const activeFileTab =
    selection.kind === 'file' ? tabs.find((t) => t.id === selection.tabId) : undefined;
  const activeFileContentError = activeFileTab
    ? fileContentErrors.get(activeFileTab.compositeKey)
    : undefined;
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
      {openApps.flatMap((app) => {
        // mounted ∩ open: keep-alive holds across tab SWITCHES only. CLOSING a
        // tab unmounts the surface (review finding) — the ✕ is the user's one
        // lever to release a runaway Canvas iframe or Changes subscriptions,
        // and reopening remounts fresh. Never-activated open tabs stay
        // unmounted until first selection.
        if (!mountedAppIds.has(app.id)) {
          return [];
        }
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
            <TabPanelBoundary label={app.label} resetKey={app.id}>
              {app.render()}
            </TabPanelBoundary>
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
          <TabPanelBoundary
            label={getFileName(activeFileTab.path)}
            resetKey={activeFileTab.compositeKey}
          >
            <FileTabBody
              content={fileContents[activeFileTab.compositeKey]}
              {...(activeFileContentError ? { contentError: activeFileContentError } : {})}
              isLoading={loadingFiles.has(activeFileTab.compositeKey)}
              isRestoring={isRestoring}
              key={activeFileTab.compositeKey}
              onRetryContent={() => onRetryFileContent(activeFileTab.compositeKey)}
              rootPath={getTabRootPath(activeFileTab, rootDescriptors)}
              status={tabStatuses.get(activeFileTab.compositeKey)}
              tab={activeFileTab}
            />
          </TabPanelBoundary>
        </div>
      ) : null}
      {showLauncher ? <WorkspaceLauncher /> : null}
    </div>
  );
}
