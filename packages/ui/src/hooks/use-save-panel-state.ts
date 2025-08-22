import { createDebounce } from '@brainstrike/hooks';
import { isDevEnv } from '@brainstrike/utils';
import { useCallback, useEffect, useRef } from 'react';
import { getElectronAPI } from '../lib/electron-utils';
import { statesEqual } from '../lib/panel-utils';
import type { PanelPersistenceState } from '../types/panel';

const STORAGE_KEY = 'panelLayout.v1';
const SAVE_DEBOUNCE_MS = 250;

export function useSavePanelState(
  onSaved: (state: PanelPersistenceState) => void,
  getLastSaved: () => PanelPersistenceState | null
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
        onSaved(stateToSave);
      } catch (_error) {
        if (isDevEnv()) {
        }
      }
    },
    [onSaved]
  );

  const { run, flush } = createDebounce(save, SAVE_DEBOUNCE_MS);

  const persist = useCallback(
    (state: PanelPersistenceState) => {
      if (pendingRef.current && statesEqual(pendingRef.current, state)) return;
      const lastSaved = getLastSaved();
      if (!pendingRef.current && statesEqual(lastSaved, state)) return;
      pendingRef.current = state;
      run(state);
    },
    [run, getLastSaved]
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
