import { isDevEnv } from '@brainstrike/utils';
import { useCallback, useEffect, useRef } from 'react';
import { createDebounce } from '../lib/debounce';
import { getElectronAPI } from '../lib/electron-utils';
import { statesEqual } from '../lib/panel-utils';
import type { PanelPersistenceState } from '../types/panel';

const STORAGE_KEY = 'panelLayout.v1';
const SAVE_DEBOUNCE_MS = 250;

export function useSavePanelState(
  lastSavedRef: React.MutableRefObject<PanelPersistenceState | null>
): { persist: (state: PanelPersistenceState) => void } {
  const pendingRef = useRef<PanelPersistenceState | null>(null);

  const save = useCallback(
    async (stateToSave: PanelPersistenceState) => {
      try {
        const electronAPI = getElectronAPI();
        if (electronAPI?.saveLayout) {
          await electronAPI.saveLayout(stateToSave);
        } else if (typeof window !== 'undefined') {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(stateToSave));
        }
        lastSavedRef.current = stateToSave;
      } catch (error) {
        if (isDevEnv()) {
          console.warn('Failed to save panel layout:', error);
        }
      }
    },
    [lastSavedRef]
  );

  const { run, flush } = createDebounce(save, SAVE_DEBOUNCE_MS);

  const persist = useCallback(
    (state: PanelPersistenceState) => {
      if (pendingRef.current && statesEqual(pendingRef.current, state)) return;
      if (!pendingRef.current && statesEqual(lastSavedRef.current, state)) return;
      pendingRef.current = state;
      run(state);
    },
    [lastSavedRef, run]
  );

  const flushPending = useCallback(() => {
    flush();
    pendingRef.current = null;
  }, [flush]);

  useEffect(() => {
    const beforeUnload = () => flushPending();
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', beforeUnload);
    }
    return () => {
      beforeUnload();
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', beforeUnload);
      }
    };
  }, [flushPending]);

  return { persist };
}
