import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useRef } from 'react';
import type { PanelPersistenceAdapter } from '../hooks/panel-persistence-adapters';
import { usePanelPersistence } from '../hooks/use-panel-persistence';
import type { PanelPersistenceState } from '../types/panel';

export interface PanelLayoutState extends PanelPersistenceState {}

export interface PanelLayoutProviderProps {
  children: ReactNode;
  initialState?: PanelLayoutState;
  adapter?: PanelPersistenceAdapter | null;
  controlledState?: PanelLayoutState;
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
  // Uncontrolled: use internal persistence hook
  const uncontrolled = usePanelPersistence(
    initialState?.sizes ?? [25, 55, 20],
    initialState?.showConsole ?? false,
    initialState?.showLeftPanel ?? true,
    initialState?.showRightPanel ?? false,
    adapter
  );

  const last = useRef<PanelLayoutState | null>(null);

  const merged: PanelLayoutContextValue = useMemo(() => {
    const state: PanelLayoutState = controlledState
      ? controlledState
      : {
          sizes: uncontrolled.sizes,
          showConsole: uncontrolled.showConsole,
          showLeftPanel: uncontrolled.showLeftPanel,
          showRightPanel: uncontrolled.showRightPanel,
        };

    const setState = (next: PanelLayoutState) => {
      last.current = next;
      if (onChange) onChange(next);
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

  return <PanelLayoutContext.Provider value={merged}>{children}</PanelLayoutContext.Provider>;
}
