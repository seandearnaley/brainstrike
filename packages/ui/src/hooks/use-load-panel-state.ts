import { isDevEnv } from '@brainstrike/utils';
import { useEffect, useRef, useState } from 'react';
import { getElectronAPI, hasElectronAPI } from '../lib/electron-utils';
import { validateAndNormalizeSizes } from '../lib/panel-utils';
import type { PanelPersistenceState } from '../types/panel';

const STORAGE_KEY = 'panelLayout.v1';

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
            sizes: validateAndNormalizeSizes(parsed.sizes ?? defaultSizes),
            showConsole: parsed.showConsole ?? defaultShowConsole,
            showLeftPanel: parsed.showLeftPanel ?? defaultShowLeftPanel,
            showRightPanel: parsed.showRightPanel ?? defaultShowRightPanel,
          };
        }
      }
    }
  } catch (_error) {
    if (isDevEnv()) {
    }
  }
  return {
    sizes: validateAndNormalizeSizes(defaultSizes),
    showConsole: defaultShowConsole,
    showLeftPanel: defaultShowLeftPanel,
    showRightPanel: defaultShowRightPanel,
  };
};

export function useLoadPanelState(
  defaultSizes: number[],
  defaultShowConsole: boolean,
  defaultShowLeftPanel: boolean,
  defaultShowRightPanel: boolean
): [
  PanelPersistenceState,
  React.Dispatch<React.SetStateAction<PanelPersistenceState>>,
  React.MutableRefObject<PanelPersistenceState | null>,
] {
  const [state, setState] = useState<PanelPersistenceState>(() =>
    loadInitialState(defaultSizes, defaultShowConsole, defaultShowLeftPanel, defaultShowRightPanel)
  );

  const lastSavedStateRef = useRef<PanelPersistenceState | null>(state);

  useEffect(() => {
    const loadElectronLayout = async () => {
      try {
        const stored = await getElectronAPI()?.loadLayout?.();
        if (stored) {
          const electronState: PanelPersistenceState = {
            sizes: validateAndNormalizeSizes(stored.sizes ?? defaultSizes),
            showConsole: stored.showConsole ?? defaultShowConsole,
            showLeftPanel: stored.showLeftPanel ?? defaultShowLeftPanel,
            showRightPanel: stored.showRightPanel ?? defaultShowRightPanel,
          };
          setState(electronState);
          lastSavedStateRef.current = electronState;
        }
      } catch (_error) {
        if (isDevEnv()) {
        }
      }
    };

    if (hasElectronAPI()) {
      void loadElectronLayout();
    }
  }, [defaultSizes, defaultShowConsole, defaultShowLeftPanel, defaultShowRightPanel]);

  return [state, setState, lastSavedStateRef];
}
