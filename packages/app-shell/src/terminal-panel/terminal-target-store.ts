import {
  TERMINAL_APP_ID,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { createWithEqualityFn as create } from 'zustand/traditional';

export interface TerminalTarget {
  readonly cwd: string;
  readonly rootId: string;
}

interface TerminalTargetState {
  readonly pin: (target: TerminalTarget) => void;
  readonly release: () => void;
  readonly target: TerminalTarget | null;
}

export const useTerminalTargetStore = create<TerminalTargetState>()((set) => ({
  pin: (target) => set({ target }),
  release: () => set({ target: null }),
  target: null,
}));

/** Pin an exact checkout and activate the singleton Terminal workspace app. */
export function openTerminalAtTarget(target: TerminalTarget): void {
  useTerminalTargetStore.getState().pin(target);
  useWorkspaceTabSelectionStore.getState().openApp(TERMINAL_APP_ID);
}
