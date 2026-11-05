import { useDatabaseStatusSync } from '@brainstrike/app-state/hooks/use-database-status-sync';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { FileExplorerProvider, FileSystemProvider } from '@brainstrike/file-explorer-ui/shell';
import {
  NavigationSidebar,
  StatusBar,
  ThemeProvider,
  ThemeToggle,
  Toaster,
  TooltipProvider,
} from '@brainstrike/ui';
import { AccountMenu } from './account-menu';
import { AppReloadStrip } from './app-reload/app-reload-strip';
import { chooseAppearance, useAppearanceStore } from './appearance-store';
import { useModelMigrationNotices } from './hooks/use-model-migration-notices';
import { StateStoreDamageNotice } from './state-health/state-store-damage-notice';
import { DatabaseStatusItem } from './status-items/database-status-item';
import { DiagnosticsStatusItem } from './status-items/diagnostics-status-item';
import { WorkspaceRootStatusItem } from './status-items/workspace-root-status-item';
import { ThreadCheckoutBridge } from './thread-checkout-bridge';
import type { AppLayoutProps } from './types';

export function AppLayout({
  children,
  config,
  currentPath,
  onNavigationClick,
  onOpenSettings,
  stateHealth,
}: AppLayoutProps) {
  useDatabaseStatusSync();
  // Session-wide, mounted once: retired-model remap toasts (BST-565).
  useModelMigrationNotices();
  const { fileSystemAdapter } = useAdapters();
  const appearance = useAppearanceStore();

  return (
    <ThemeProvider
      appearance={appearance}
      defaultMode="light"
      onAppearanceChange={chooseAppearance}
    >
      <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        <FileExplorerProvider fileSystemAdapter={fileSystemAdapter}>
          {/* ONE shared file-system instance for the entire app surface
              (explorer, database panel, assistant, settings). MUST mount
              BELOW FileExplorerProvider — the instance reads the store — and
              below the thread checkout it shows in place of its folder. */}
          <ThreadCheckoutBridge>
            <FileSystemProvider>
              <div className="flex h-screen flex-col">
                <div className="flex min-h-0 flex-1">
                  {/* The rail is the window's top-left corner, so on macOS it holds
                    the traffic lights: it reserves the window controls' safe
                    area (`env(titlebar-area-*)`, 0 without an overlay or in
                    fullscreen) and its empty space moves the window. */}
                  <NavigationSidebar
                    className="app-window-drag min-w-[env(titlebar-area-x,0px)] pt-[max(1rem,env(titlebar-area-height,0px))]"
                    currentPath={currentPath}
                    items={config.navigationItems}
                    {...(onNavigationClick && { onItemClick: onNavigationClick })}
                  >
                    <ThemeToggle />
                    {onOpenSettings ? <AccountMenu onOpenSettings={onOpenSettings} /> : null}
                  </NavigationSidebar>
                  <div className="flex min-w-0 flex-1 flex-col">
                    {/* Persistent app-reload strip (failed lazy chunk). It sits
                      in the column, so the content below shrinks by its height.
                      Beside the rail, not above it, so it never sits under the
                      traffic lights. */}
                    <AppReloadStrip />
                    {/* A damaged canonical state store, opened read-only (BST-1880).
                      Renders nothing without the desktop state-health capability. */}
                    <StateStoreDamageNotice capability={stateHealth ?? null} />
                    {/* `relative overflow-clip` makes main the containing block, and the clip,
                      for every absolutely positioned descendant without a closer
                      positioned ancestor (an `sr-only` label in a long list).
                      Otherwise those resolve against the window and stretch the
                      document, which then scrolls past the status bar. */}
                    <main className="relative min-h-0 flex-1 overflow-clip">{children}</main>
                  </div>
                </div>
                {/* Status bar at bottom */}
                <StatusBar
                  leftContent={
                    <>
                      <DatabaseStatusItem />
                      {/* Workspace root identity (Main vs Focused clarity):
                        renders nothing until a folder is mounted. */}
                      <WorkspaceRootStatusItem />
                    </>
                  }
                  rightContent={<DiagnosticsStatusItem />}
                />
              </div>
              <Toaster />
            </FileSystemProvider>
          </ThreadCheckoutBridge>
        </FileExplorerProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
