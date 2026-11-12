/**
 * ADR-0034 decision 3: the Explorer's header changes where the active thread works through the
 * composer's where-control, never through a menu of its own, so the thread binding stays the one
 * writer and `useWorkspaceBar` runs once. This is the only thing the two share: how many
 * where-controls are shown, and a count the header raises to open them.
 *
 * In memory only: nothing here outlives the window.
 */
import { create } from 'zustand';

interface WhereControlRequests {
  /** Raised to open the shown where-control (`WorkspaceBarProps.openRequest`). */
  readonly openRequest: number;
  /** Composer workspace bars shown now; the header offers its control only while there is one. */
  readonly shown: number;
}

export const useWhereControlRequests = create<WhereControlRequests>(() => ({
  openRequest: 0,
  shown: 0,
}));

/** A composer workspace bar is shown; the returned function says it is gone. */
export function showWhereControl(): () => void {
  useWhereControlRequests.setState((state) => ({ shown: state.shown + 1 }));
  return () => {
    useWhereControlRequests.setState((state) => ({ shown: state.shown - 1 }));
  };
}

/** Opens the shown where-control. */
export function requestWhereControlOpen(): void {
  useWhereControlRequests.setState((state) => ({ openRequest: state.openRequest + 1 }));
}
