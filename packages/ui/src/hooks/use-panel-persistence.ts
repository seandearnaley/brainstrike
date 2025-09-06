import { isDevEnv } from '@brainstrike/utils';
import { useCallback, useRef } from 'react';
import { validateAndNormalizeSizes } from '../lib/panel-utils';
import type { PanelPersistenceState } from '../types/panel';
import type { PanelPersistenceAdapter } from './panel-persistence-adapters';
import { useLoadPanelState } from './use-load-panel-state';
import { useSavePanelState } from './use-save-panel-state';

export function usePanelPersistence(
  defaultSizes: number[],
  defaultShowConsole = false,
  defaultShowLeftPanel = true,
  defaultShowRightPanel = false,
  adapter?: PanelPersistenceAdapter | null
) {
  // Phase 2: In dev, disallow implicit adapter selection; require explicit adapter
  if (!adapter && isDevEnv()) {
    throw new Error(
      '[usePanelPersistence] Missing explicit persistence adapter. ' +
        'Pass LocalStoragePanelPersistenceAdapter or ElectronPanelPersistenceAdapter explicitly.'
    );
  }
  const [state, setState, lastSavedRef, isHydrated] = useLoadPanelState(
    defaultSizes,
    defaultShowConsole,
    defaultShowLeftPanel,
    defaultShowRightPanel,
    adapter
  );

  // Track last-saved state locally to avoid mutating a value returned from another hook
  const lastSavedLocalRef = useRef<PanelPersistenceState | null>(lastSavedRef.current);

  const { persist } = useSavePanelState(
    (saved) => {
      lastSavedLocalRef.current = saved;
    },
    () => lastSavedLocalRef.current,
    adapter
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
      persist(updatedState);
    },
    [state, setState, persist]
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

  return {
    sizes: state.sizes,
    showConsole: state.showConsole,
    showLeftPanel: state.showLeftPanel,
    showRightPanel: state.showRightPanel,
    isHydrated,
    saveLayout,
    toggleConsole,
    toggleLeftPanel,
    toggleRightPanel,
  };
}

export type { PanelPersistenceState } from '../types/panel';
