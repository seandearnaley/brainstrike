import { createAppConfig, navigationItems, RightPanel } from '@brainstrike/app-shell';
import { FileExplorerLeftPanel, TabbedFileEditorPanel } from '@brainstrike/file-explorer-ui';
import { CustomTitlebar, IdeLayout } from '@brainstrike/ui';
import { useCallback, useMemo, useState } from 'react';
import { DesktopAppLayout } from './desktop-app-layout';
import HomePageContent from './home-page-content';
import SettingsPageContent from './settings/page-content';

/**
 * Desktop-specific root layout that includes the custom titlebar
 * and uses the ElectronThemeProvider for native theme integration.
 */
export function DesktopRootLayoutContent() {
  const [activeTab, setActiveTab] = useState('explorer');
  const appConfig = useMemo(() => createAppConfig({ navigationItems }), []);

  const handleNavigationClick = useCallback((path: string) => {
    const tab = path === '/' ? 'explorer' : 'settings';
    setActiveTab(tab);
  }, []);

  const sidebarContent = useMemo(() => <FileExplorerLeftPanel />, []);
  const tabbedEditorContent = useMemo(() => <TabbedFileEditorPanel className="h-full" />, []);
  const rightPanelContent = useMemo(() => <RightPanel />, []);

  return (
    <div className="h-screen flex flex-col">
      <CustomTitlebar title="BrainStrike" />
      <div className="flex-1 overflow-hidden">
        <DesktopAppLayout
          config={appConfig}
          currentPath={activeTab === 'explorer' ? '/' : '/settings'}
          onNavigationClick={handleNavigationClick}
        >
          <div
            data-testid="explorer-section"
            className={activeTab === 'explorer' ? 'block h-full' : 'hidden h-full'}
          >
            <IdeLayout
              leftPanelContent={sidebarContent}
              rightPanelContent={rightPanelContent}
              consoleContent={tabbedEditorContent}
            >
              <HomePageContent />
            </IdeLayout>
          </div>

          <div
            data-testid="settings-section"
            className={activeTab === 'settings' ? 'block h-full' : 'hidden h-full'}
          >
            <SettingsPageContent />
          </div>
        </DesktopAppLayout>
      </div>
    </div>
  );
}
