import { createDebounce } from '@brainstrike/utils/create-debounce';
import { isDevEnv } from '@brainstrike/utils/env-utils';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('UseSavePanelState');

import { useCallback, useEffect, useRef } from 'react';
import { statesEqual } from '../lib/panel-utils';
import type { PanelPersistenceState } from '../types/panel';
import type { PanelPersistenceAdapter } from './panel-persistence-adapters';

const SAVE_DEBOUNCE_MS = 250;

export function useSavePanelState(
  onSaved: (state: PanelPersistenceState) => void,
  getLastSaved: () => PanelPersistenceState | null,
  adapter?: PanelPersistenceAdapter | null
): { persist: (state: PanelPersistenceState) => void; flush: () => void } {
  const pendingRef = useRef<PanelPersistenceState | null>(null);

  const save = useCallback(
    async (stateToSave: PanelPersistenceState) => {
      try {
        if (adapter) {
          await adapter.save(stateToSave);
        } else {
          throw new Error('[useSavePanelState] Missing adapter in Phase 3');
        }
        onSaved(stateToSave);
      } catch (error) {
        if (isDevEnv()) {
          logger.warn('Failed to save panel state', {
            error,
            hasAdapter: Boolean(adapter),
          });
        }
      }
    },
    [onSaved, adapter]
  );

  // Stable ref to always call the latest save function without recreating the debounce instance
  const saveRef = useRef(save);
  saveRef.current = save;

  const debounceRef = useRef<ReturnType<typeof createDebounce<[PanelPersistenceState]>> | null>(
    null
  );
  if (!debounceRef.current) {
    debounceRef.current = createDebounce(
      (...args: [PanelPersistenceState]) => saveRef.current(...args),
      SAVE_DEBOUNCE_MS
    );
  }

  const persist = useCallback(
    (state: PanelPersistenceState) => {
      if (pendingRef.current && statesEqual(pendingRef.current, state)) {
        return;
      }
      const lastSaved = getLastSaved();
      if (!pendingRef.current && statesEqual(lastSaved, state)) {
        return;
      }
      pendingRef.current = state;
      debounceRef.current?.run(state);
    },
    [getLastSaved]
  );

  const flushPending = useCallback(() => {
    void debounceRef.current?.flush();
    pendingRef.current = null;
  }, []);

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

  return { flush: flushPending, persist };
}
