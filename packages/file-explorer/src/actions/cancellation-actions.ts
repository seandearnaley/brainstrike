import type { FileExplorerState } from '@brainstrike/types';
import type { StateCreator } from 'zustand';

export interface CancellationActions {
  setLoadingCancellable: (value: boolean) => void;
  setCancelling: (value: boolean) => void;
  setCancelled: (value: boolean) => void;
  cancelLoading: () => void;
}

export const createCancellationActions: StateCreator<
  FileExplorerState,
  [],
  [],
  CancellationActions
> = (set, get) => ({
  setLoadingCancellable: (value) => set({ isCancellable: value }),
  setCancelling: (value) => set({ isCancelling: value }),
  setCancelled: (value) => set({ isCancelled: value }),
  cancelLoading: () => {
    // Assuming currentAbortController is accessible via get()
    // This might need adjustment later if currentAbortController is managed differently.
    const currentAbortController = (get() as any).currentAbortController as AbortController | undefined;
    if (currentAbortController) {
      currentAbortController.abort();
    }
    set({ isCancelling: true });
  },
});
