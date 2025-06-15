import { isDevEnv } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutElectronAPI } from '../types/electron';

const STORAGE_KEY = 'panelLayout.v1';
const SAVE_DEBOUNCE_MS = 250; // Debounce storage writes

const statesEqual = (a: PanelPersistenceState | null, b: PanelPersistenceState): boolean => {
  return (
    !!a &&
    a.sizes.length === b.sizes.length &&
    a.sizes.every((v, i) => v === b.sizes[i]) &&
    a.showConsole === b.showConsole &&
    a.showLeftPanel === b.showLeftPanel &&
    a.showRightPanel === b.showRightPanel
  );
};

// Validate and normalize layout sizes to ensure they add up to 100%
const validateAndNormalizeSizes = (sizes: number[]): number[] => {
  if (!sizes || sizes.length === 0) return [];

  // Filter out invalid values
  const validSizes = sizes.map((size) => {
    const num = typeof size === 'number' && !Number.isNaN(size) ? size : 0;
    return Math.max(0, Math.min(100, num)); // Clamp between 0 and 100
  });

  const total = validSizes.reduce((sum, size) => sum + size, 0);

  // If total is 0, return default equal distribution
  if (total === 0) {
    return validSizes.map(() => 100 / validSizes.length);
  }

  // Only normalize if total exceeds 100% (invalid state)
  if (total > 100) {
    return validSizes.map((size) => (size / total) * 100);
  }

  // For totals less than or equal to 100%, keep the original values
  return validSizes;
};

export interface PanelPersistenceState {
  sizes: number[];
  showConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
}

// Load initial state from storage with proper error handling
const loadInitialState = (
  defaultSizes: number[],
  defaultShowConsole: boolean,
  defaultShowLeftPanel: boolean,
  defaultShowRightPanel: boolean
): PanelPersistenceState => {
  try {
    if (typeof window !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PanelPersistenceState;
        if (parsed && typeof parsed === 'object') {
          return {
            sizes: validateAndNormalizeSizes(parsed.sizes || defaultSizes),
            showConsole: parsed.showConsole ?? defaultShowConsole,
            showLeftPanel: parsed.showLeftPanel ?? defaultShowLeftPanel,
            showRightPanel: parsed.showRightPanel ?? defaultShowRightPanel,
          };
        }
      }
    }
  } catch (error) {
    if (isDevEnv()) {
      console.warn('Failed to load panel layout from localStorage:', error);
    }
  }

  return {
    sizes: validateAndNormalizeSizes(defaultSizes),
    showConsole: defaultShowConsole,
    showLeftPanel: defaultShowLeftPanel,
    showRightPanel: defaultShowRightPanel,
  };
};

export function usePanelPersistence(
  defaultSizes: number[],
  defaultShowConsole = false,
  defaultShowLeftPanel = true,
  defaultShowRightPanel = false
) {
  const hasLoadedFromElectron = useRef<boolean>(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const pendingStateRef = useRef<PanelPersistenceState | null>(null);
  const lastSavedStateRef = useRef<PanelPersistenceState | null>(null);

  const [state, setState] = useState<PanelPersistenceState>(() =>
    loadInitialState(defaultSizes, defaultShowConsole, defaultShowLeftPanel, defaultShowRightPanel)
  );

  if (lastSavedStateRef.current === null) {
    lastSavedStateRef.current = state;
  }

  const executeSave = useCallback(async (stateToSave: PanelPersistenceState) => {
    try {
      const electronAPI = (window as { electronAPI?: LayoutElectronAPI }).electronAPI;
      if (electronAPI?.saveLayout) {
        await electronAPI.saveLayout(stateToSave);
      } else if (typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stateToSave));
      }
      lastSavedStateRef.current = stateToSave;
    } catch (error) {
      if (isDevEnv()) {
        console.warn('Failed to save panel layout:', error);
      }
    }
  }, []);

  const persistToStorage = useCallback(
    (newState: PanelPersistenceState) => {
      if (pendingStateRef.current && statesEqual(pendingStateRef.current, newState)) {
        return;
      }
      if (!pendingStateRef.current && statesEqual(lastSavedStateRef.current, newState)) {
        return;
      }

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = undefined;
      }

      pendingStateRef.current = newState;

      saveTimeoutRef.current = setTimeout(() => {
        if (pendingStateRef.current) {
          executeSave(pendingStateRef.current);
          pendingStateRef.current = null;
        }
        saveTimeoutRef.current = undefined;
      }, SAVE_DEBOUNCE_MS);
    },
    [executeSave]
  );

  const saveLayout = useCallback(
    (
      newSizes: number[],
      newShowConsole?: boolean,
      newShowLeftPanel?: boolean,
      newShowRightPanel?: boolean
    ) => {
      const normalizedSizes = validateAndNormalizeSizes(newSizes);
      const updatedState: PanelPersistenceState = {
        sizes: normalizedSizes,
        showConsole: newShowConsole ?? state.showConsole,
        showLeftPanel: newShowLeftPanel ?? state.showLeftPanel,
        showRightPanel: newShowRightPanel ?? state.showRightPanel,
      };
      setState(updatedState);
      persistToStorage(updatedState);
    },
    [state, persistToStorage]
  );

  const toggleConsole = useCallback(() => {
    saveLayout(state.sizes, !state.showConsole, state.showLeftPanel, state.showRightPanel);
  }, [state, saveLayout]);

  const toggleLeftPanel = useCallback(() => {
    saveLayout(state.sizes, state.showConsole, !state.showLeftPanel, state.showRightPanel);
  }, [state, saveLayout]);

  const toggleRightPanel = useCallback(() => {
    saveLayout(state.sizes, state.showConsole, state.showLeftPanel, !state.showRightPanel);
  }, [state, saveLayout]);

  useEffect(() => {
    const loadElectronLayout = async () => {
      try {
        const electronAPI = (window as { electronAPI?: LayoutElectronAPI }).electronAPI;
        if (electronAPI?.loadLayout) {
          const stored = await electronAPI.loadLayout();
          if (stored) {
            const electronState: PanelPersistenceState = {
              sizes: validateAndNormalizeSizes(stored.sizes || defaultSizes),
              showConsole: stored.showConsole ?? defaultShowConsole,
              showLeftPanel: stored.showLeftPanel ?? defaultShowLeftPanel,
              showRightPanel: stored.showRightPanel ?? defaultShowRightPanel,
            };
            setState(electronState);
            lastSavedStateRef.current = electronState;
          }
        }
      } catch (error) {
        if (isDevEnv()) {
          console.warn('Failed to load panel layout from Electron:', error);
        }
      }
    };

    // Only try to load from Electron API if it's actually available
    // In browser environments, this prevents overriding the localStorage state
    if (
      !hasLoadedFromElectron.current &&
      typeof window !== 'undefined' &&
      (window as any).electronAPI
    ) {
      hasLoadedFromElectron.current = true;
      loadElectronLayout();
    } else if (!hasLoadedFromElectron.current) {
      // Mark as loaded to prevent future attempts in browser environments
      hasLoadedFromElectron.current = true;
    }
  }, [defaultSizes, defaultShowConsole, defaultShowLeftPanel, defaultShowRightPanel]);

  useEffect(() => {
    const flushPendingSave = () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = undefined;
      }
      if (pendingStateRef.current) {
        executeSave(pendingStateRef.current);
        pendingStateRef.current = null;
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', flushPendingSave);
    }

    return () => {
      flushPendingSave();
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', flushPendingSave);
      }
    };
  }, [executeSave]);

  return {
    sizes: state.sizes,
    showConsole: state.showConsole,
    showLeftPanel: state.showLeftPanel,
    showRightPanel: state.showRightPanel,
    saveLayout,
    toggleConsole,
    toggleLeftPanel,
    toggleRightPanel,
  };
}
