import { useEffect, useRef, useState } from 'react';
import { validateAndNormalizeSizes } from '../lib/panel-utils';
import type { PanelPersistenceState } from '../types/panel';
import type { PanelPersistenceAdapter } from './panel-persistence-adapters';

export function useLoadPanelState(
  defaultSizes: number[],
  defaultShowConsole: boolean,
  defaultShowLeftPanel: boolean,
  defaultShowRightPanel: boolean,
  adapter?: PanelPersistenceAdapter | null
): [
  PanelPersistenceState,
  React.Dispatch<React.SetStateAction<PanelPersistenceState>>,
  React.MutableRefObject<PanelPersistenceState | null>,
  boolean,
] {
  // Start from defaults; adapter (if provided) will hydrate asynchronously
  const [state, setState] = useState<PanelPersistenceState>(() => ({
    sizes: validateAndNormalizeSizes(defaultSizes),
    showConsole: defaultShowConsole,
    showLeftPanel: defaultShowLeftPanel,
    showRightPanel: defaultShowRightPanel,
  }));

  const lastSavedStateRef = useRef<PanelPersistenceState | null>(state);
  const [isHydrated, setIsHydrated] = useState<boolean>(() => !adapter);

  useEffect(() => {
    const loadFromAdapter = async () => {
      if (!adapter) return;
      try {
        const stored = await adapter.load();
        if (stored) {
          const loadedState: PanelPersistenceState = {
            sizes: validateAndNormalizeSizes(stored.sizes ?? defaultSizes),
            showConsole: stored.showConsole ?? defaultShowConsole,
            showLeftPanel: stored.showLeftPanel ?? defaultShowLeftPanel,
            showRightPanel: stored.showRightPanel ?? defaultShowRightPanel,
          };
          setState(loadedState);
          lastSavedStateRef.current = loadedState;
        }
      } catch {}
      setIsHydrated(true);
    };

    if (adapter) {
      void loadFromAdapter();
    }
  }, [defaultSizes, defaultShowConsole, defaultShowLeftPanel, defaultShowRightPanel, adapter]);

  return [state, setState, lastSavedStateRef, isHydrated];
}
