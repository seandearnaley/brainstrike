import { type FileTabState, useTabManagerStore } from '../stores/tab-manager-store';

export type FileTab = FileTabState;

export interface UseTabManagerReturn {
  activeTabId: string | null;
  clearTabs: () => void;
  closeTab: (tabId: string) => string | null;
  openTab: (path: string, tabId: string, compositeKey: string) => void;
  setActiveTab: (tabId: string) => void;
  setTabError: (tabId: string, error: string) => void;
  setTabLoading: (tabId: string, isLoading: boolean) => void;
  tabs: FileTab[];
  updateTabContent: (tabId: string, content: string) => void;
}

export function useTabManager(): UseTabManagerReturn {
  const tabs = useTabManagerStore((s) => s.tabs);
  const activeTabId = useTabManagerStore((s) => s.activeTabId);
  const openTab = useTabManagerStore((s) => s.openTab);
  const closeTab = useTabManagerStore((s) => s.closeTab);
  const setActiveTab = useTabManagerStore((s) => s.setActiveTab);
  const updateTabContent = useTabManagerStore((s) => s.updateTabContent);
  const setTabLoading = useTabManagerStore((s) => s.setTabLoading);
  const setTabError = useTabManagerStore((s) => s.setTabError);
  const clearTabs = useTabManagerStore((s) => s.clearTabs);

  return {
    tabs,
    activeTabId,
    openTab,
    closeTab,
    setActiveTab,
    updateTabContent,
    setTabLoading,
    setTabError,
    clearTabs,
  };
}
