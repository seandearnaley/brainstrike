import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';

/** Panel layout; `sizes` is `[left, right, console]` as percentages. */
export interface PanelLayoutState {
  showConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  sizes: number[];
}

/**
 * Controlled only: the owner of `controlledState` is the one writer of the
 * layout, and every change IdeLayout makes reaches it through `onChange`.
 */
export interface PanelLayoutProviderProps {
  children: ReactNode;
  controlledState: PanelLayoutState;
  onChange: (state: PanelLayoutState) => void;
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
  controlledState,
  onChange,
}: PanelLayoutProviderProps) {
  const value = useMemo(
    () => ({ ...controlledState, setState: onChange }),
    [controlledState, onChange]
  );

  return <PanelLayoutContext.Provider value={value}>{children}</PanelLayoutContext.Provider>;
}
