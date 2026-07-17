import { isDevEnv } from '@brainstrike/utils/env-utils';
import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useRef } from 'react';
import type { PanelPersistenceAdapter } from '../hooks/panel-persistence-adapters';
import { usePanelPersistence } from '../hooks/use-panel-persistence';
import type { PanelPersistenceState } from '../types/panel';

export type PanelLayoutState = PanelPersistenceState;

export interface PanelLayoutProviderProps {
  adapter?: PanelPersistenceAdapter | null;
  children: ReactNode;
  controlledState?: PanelLayoutState;
  initialState?: PanelLayoutState;
  onChange?: (state: PanelLayoutState) => void;
}

interface PanelLayoutContextValue extends PanelLayoutState {
  setState: (state: PanelLayoutState) => void;
}

const PanelLayoutContext = createContext<PanelLayoutContextValue | null>(null);

export function usePanelLayout(): PanelLayoutContextValue | null {
  return useContext(PanelLayoutContext);
}

export function PanelLayoutProvider({
  children,
  initialState,
  adapter,
  controlledState,
  onChange,
}: PanelLayoutProviderProps) {
  // Phase 2: In dev, require adapter for uncontrolled mode
  if (!(controlledState || adapter) && isDevEnv()) {
    throw new Error(
      '[PanelLayoutProvider] Missing persistence adapter for uncontrolled mode. ' +
        'Provide LocalStoragePanelPersistenceAdapter or ElectronPanelPersistenceAdapter, ' +
        'or use controlledState/onChange to manage panel state.'
    );
  }

  // Uncontrolled: use internal persistence hook
  // sizes format: [leftPanelSize, rightPanelSize, consolePanelSize]
  // The middle panel size is calculated as: 100 - left - right
  const uncontrolled = usePanelPersistence(
    initialState?.sizes ?? [25, 20, 20],
    initialState?.showConsole ?? false,
    initialState?.showLeftPanel ?? true,
    initialState?.showRightPanel ?? false,
    adapter
  );

  const last = useRef<PanelLayoutState | null>(null);

  const merged: PanelLayoutContextValue | null = useMemo(() => {
    const state: PanelLayoutState = controlledState
      ? controlledState
      : {
          showConsole: uncontrolled.showConsole,
          showLeftPanel: uncontrolled.showLeftPanel,
          showRightPanel: uncontrolled.showRightPanel,
          sizes: uncontrolled.sizes,
        };

    const setState = (next: PanelLayoutState) => {
      last.current = next;
      if (onChange) {
        onChange(next);
      }
      if (!controlledState) {
        uncontrolled.saveLayout(
          next.sizes,
          next.showConsole,
          next.showLeftPanel,
          next.showRightPanel
        );
      }
    };

    return { ...state, setState };
  }, [controlledState, uncontrolled, onChange]);

  // Gate rendering until hydrated when using uncontrolled mode with adapter
  if (!controlledState && adapter && !uncontrolled.isHydrated) {
    return null;
  }

  return <PanelLayoutContext.Provider value={merged}>{children}</PanelLayoutContext.Provider>;
}
