import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutElectronAPI } from '../types/electron';

const STORAGE_KEY = 'panelLayout.v1';
const SAVE_DEBOUNCE_MS = 100; // Debounce storage writes

export interface PanelPersistenceState {
  sizes: number[];
  showConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
}

export function usePanelPersistence(
  defaultSizes: number[],
  defaultShowConsole = false,
  defaultShowLeftPanel = true,
  defaultShowRightPanel = false
) {
  const hasLoadedFromElectron = useRef<boolean>(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const pendingStateRef = useRef<PanelPersistenceState | null>(null);

  const [sizes, setSizes] = useState<number[]>(() => {
    try {
      if (typeof window !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as PanelPersistenceState;
          return parsed.sizes || defaultSizes;
        }
      }
      return defaultSizes;
    } catch {
      return defaultSizes;
    }
  });

  const [showConsole, setShowConsole] = useState<boolean>(() => {
    try {
      if (typeof window !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as PanelPersistenceState;
          return parsed.showConsole ?? defaultShowConsole;
        }
      }
      return defaultShowConsole;
    } catch {
      return defaultShowConsole;
    }
  });

  const [showLeftPanel, setShowLeftPanel] = useState<boolean>(() => {
    try {
      if (typeof window !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as PanelPersistenceState;
          return parsed.showLeftPanel ?? defaultShowLeftPanel;
        }
      }
      return defaultShowLeftPanel;
    } catch {
      return defaultShowLeftPanel;
    }
  });

  const [showRightPanel, setShowRightPanel] = useState<boolean>(() => {
    try {
      if (typeof window !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as PanelPersistenceState;
          return parsed.showRightPanel ?? defaultShowRightPanel;
        }
      }
      return defaultShowRightPanel;
    } catch {
      return defaultShowRightPanel;
    }
  });

  // Debounced storage persistence
  const persistToStorage = useCallback((state: PanelPersistenceState) => {
    // Clear any existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Store the pending state
    pendingStateRef.current = state;

    // Set a new timeout
    saveTimeoutRef.current = setTimeout(async () => {
      if (!pendingStateRef.current) return;

      try {
        // Check if we're in Electron environment
        const electronAPI = (window as { electronAPI?: LayoutElectronAPI }).electronAPI;
        if (electronAPI?.saveLayout) {
          // For Electron, save asynchronously. Ensure it completes.
          await electronAPI.saveLayout(pendingStateRef.current);
        } else if (typeof window !== 'undefined') {
          // For web, use requestIdleCallback to avoid blocking the UI
          if ('requestIdleCallback' in window) {
            window.requestIdleCallback(() => {
              if (pendingStateRef.current) {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingStateRef.current));
              }
            });
          } else {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingStateRef.current));
          }
        }
      } catch (error) {
        console.warn('Failed to save panel layout:', error);
      }

      pendingStateRef.current = null;
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const saveLayout = useCallback(
    (
      newSizes: number[],
      newShowConsole?: boolean,
      newShowLeftPanel?: boolean,
      newShowRightPanel?: boolean
    ) => {
      const updatedSizes = newSizes;
      const updatedShowConsole = newShowConsole ?? showConsole;
      const updatedShowLeftPanel = newShowLeftPanel ?? showLeftPanel;
      const updatedShowRightPanel = newShowRightPanel ?? showRightPanel;

      // Update all state immediately
      setSizes(updatedSizes);
      setShowConsole(updatedShowConsole);
      setShowLeftPanel(updatedShowLeftPanel);
      setShowRightPanel(updatedShowRightPanel);

      const state: PanelPersistenceState = {
        sizes: updatedSizes,
        showConsole: updatedShowConsole,
        showLeftPanel: updatedShowLeftPanel,
        showRightPanel: updatedShowRightPanel,
      };

      // Persist to storage with debouncing
      persistToStorage(state);
    },
    [showConsole, showLeftPanel, showRightPanel, persistToStorage]
  );

  const toggleConsole = useCallback(() => {
    saveLayout(sizes, !showConsole, showLeftPanel, showRightPanel);
  }, [sizes, showConsole, showLeftPanel, showRightPanel, saveLayout]);

  const toggleLeftPanel = useCallback(() => {
    saveLayout(sizes, showConsole, !showLeftPanel, showRightPanel);
  }, [sizes, showConsole, showLeftPanel, showRightPanel, saveLayout]);

  const toggleRightPanel = useCallback(() => {
    saveLayout(sizes, showConsole, showLeftPanel, !showRightPanel);
  }, [sizes, showConsole, showLeftPanel, showRightPanel, saveLayout]);

  useEffect(() => {
    // Load layout from Electron store if available
    const loadElectronLayout = async () => {
      try {
        const electronAPI = (window as { electronAPI?: LayoutElectronAPI }).electronAPI;
        if (electronAPI?.loadLayout) {
          const stored = await electronAPI.loadLayout();
          if (stored) {
            setSizes(stored.sizes || defaultSizes);
            setShowConsole(stored.showConsole ?? defaultShowConsole);
            setShowLeftPanel(stored.showLeftPanel ?? defaultShowLeftPanel);
            setShowRightPanel(stored.showRightPanel ?? defaultShowRightPanel);
          }
        }
      } catch (error) {
        console.warn('Failed to load panel layout from Electron:', error);
      }
    };

    if (!hasLoadedFromElectron.current) {
      hasLoadedFromElectron.current = true;
      loadElectronLayout();
    }
  }, [defaultSizes, defaultShowConsole, defaultShowLeftPanel, defaultShowRightPanel]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  return {
    sizes,
    showConsole,
    showLeftPanel,
    showRightPanel,
    saveLayout,
    toggleConsole,
    toggleLeftPanel,
    toggleRightPanel,
  };
}
