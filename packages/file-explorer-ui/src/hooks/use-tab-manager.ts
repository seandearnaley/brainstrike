import { type FileTabState, useTabManagerStore } from '../stores/tab-manager-store';

export type FileTab = FileTabState;

export interface UseTabManagerReturn {
  tabs: FileTab[];
  activeTabId: string | null;
  openTab: (path: string, tabId: string, compositeKey: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabContent: (tabId: string, content: string) => void;
  setTabLoading: (tabId: string, isLoading: boolean) => void;
  setTabError: (tabId: string, error: string) => void;
  clearTabs: () => void;
}

export function useTabManager(): UseTabManagerReturn {
  const store = useTabManagerStore;
  const tabs = store((s) => s.tabs);
  const activeTabId = store((s) => s.activeTabId);
  const openTab = store((s) => s.openTab);
  const closeTab = store((s) => s.closeTab);
  const setActiveTab = store((s) => s.setActiveTab);
  const updateTabContent = store((s) => s.updateTabContent);
  const setTabLoading = store((s) => s.setTabLoading);
  const setTabError = store((s) => s.setTabError);
  const clearTabs = store((s) => s.clearTabs);

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
