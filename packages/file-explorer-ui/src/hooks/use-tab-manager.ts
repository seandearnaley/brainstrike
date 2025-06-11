import { useCallback, useEffect, useState } from 'react';

const TAB_STATE_STORAGE_KEY = 'fileEditorTabs.v1';

export interface FileTab {
  id: string;
  path: string;
  content: string | null;
  isLoading: boolean;
  error?: string | undefined;
}

interface TabState {
  tabs: FileTab[];
  activeTabId: string | null;
}

// Helper functions for localStorage
const saveTabState = (state: TabState): void => {
  try {
    localStorage.setItem(TAB_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('Failed to save tab state:', error);
  }
};

const loadTabState = (): TabState | null => {
  try {
    const saved = localStorage.getItem(TAB_STATE_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as TabState;
      // Reset loading states and errors when restoring
      const cleanedTabs = parsed.tabs.map((tab) => ({
        ...tab,
        isLoading: false,
        error: undefined as string | undefined,
      }));
      return { ...parsed, tabs: cleanedTabs };
    }
  } catch (error) {
    console.warn('Failed to load tab state:', error);
  }
  return null;
};

export interface UseTabManagerReturn {
  tabs: FileTab[];
  activeTabId: string | null;
  openTab: (path: string, compositeKey: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabContent: (tabId: string, content: string) => void;
  setTabLoading: (tabId: string, isLoading: boolean) => void;
  setTabError: (tabId: string, error: string) => void;
  clearTabs: () => void;
}

export function useTabManager(): UseTabManagerReturn {
  // Initialize state from localStorage
  const [tabs, setTabs] = useState<FileTab[]>(() => {
    const saved = loadTabState();
    return saved?.tabs || [];
  });
  const [activeTabId, setActiveTabId] = useState<string | null>(() => {
    const saved = loadTabState();
    return saved?.activeTabId || null;
  });

  // Save state to localStorage whenever it changes
  useEffect(() => {
    const state: TabState = { tabs, activeTabId };
    saveTabState(state);
  }, [tabs, activeTabId]);

  const openTab = useCallback((path: string, compositeKey: string) => {
    setTabs((prevTabs) => {
      // Check if tab already exists
      const existingTab = prevTabs.find((tab) => tab.id === compositeKey);
      if (existingTab) {
        setActiveTabId(compositeKey);
        return prevTabs;
      }

      // Create new tab
      const newTab: FileTab = {
        id: compositeKey,
        path,
        content: null,
        isLoading: true,
      };

      const newTabs = [...prevTabs, newTab];
      setActiveTabId(compositeKey);
      return newTabs;
    });
  }, []);

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prevTabs) => {
        const newTabs = prevTabs.filter((tab) => tab.id !== tabId);

        // If we're closing the active tab, switch to another tab or clear active
        if (activeTabId === tabId) {
          const remainingTabs = newTabs;
          if (remainingTabs.length > 0) {
            const tabIndex = prevTabs.findIndex((tab) => tab.id === tabId);
            // Try to activate the tab to the right, then left, then first
            const nextTab =
              remainingTabs[tabIndex] || remainingTabs[tabIndex - 1] || remainingTabs[0];
            if (nextTab) {
              setActiveTabId(nextTab.id);
            } else {
              setActiveTabId(null);
            }
          } else {
            setActiveTabId(null);
          }
        }

        return newTabs;
      });
    },
    [activeTabId]
  );

  const setActiveTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  const updateTabContent = useCallback((tabId: string, content: string) => {
    setTabs((prevTabs) =>
      prevTabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, content, isLoading: false, error: undefined as string | undefined }
          : tab
      )
    );
  }, []);

  const setTabLoading = useCallback((tabId: string, isLoading: boolean) => {
    setTabs((prevTabs) =>
      prevTabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, isLoading, error: isLoading ? (undefined as string | undefined) : tab.error }
          : tab
      )
    );
  }, []);

  const setTabError = useCallback((tabId: string, error: string) => {
    setTabs((prevTabs) =>
      prevTabs.map((tab) => (tab.id === tabId ? { ...tab, error, isLoading: false } : tab))
    );
  }, []);

  const clearTabs = useCallback(() => {
    setTabs([]);
    setActiveTabId(null);
  }, []);

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
