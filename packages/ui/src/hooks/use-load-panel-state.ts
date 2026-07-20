import { createLogger } from '@brainstrike/utils/logger';
import { useEffect, useRef, useState } from 'react';
import { validateAndNormalizeSizes } from '../lib/panel-utils';
import type { PanelPersistenceState } from '../types/panel';
import type { PanelPersistenceAdapter } from './panel-persistence-adapters';

const logger = createLogger('UseLoadPanelState');

export function useLoadPanelState(
  defaultSizes: number[],
  defaultShowConsole: boolean,
  defaultShowLeftPanel: boolean,
  defaultShowRightPanel: boolean,
  adapter?: PanelPersistenceAdapter | null
): [
  PanelPersistenceState,
  React.Dispatch<React.SetStateAction<PanelPersistenceState>>,
  React.MutableRefObject<PanelPersistenceState | null>,
  boolean,
] {
  // Start from defaults; adapter (if provided) will hydrate asynchronously
  const [state, setState] = useState<PanelPersistenceState>(() => ({
    showConsole: defaultShowConsole,
    showLeftPanel: defaultShowLeftPanel,
    showRightPanel: defaultShowRightPanel,
    sizes: validateAndNormalizeSizes(defaultSizes),
  }));

  const lastSavedStateRef = useRef<PanelPersistenceState | null>(state);
  const [isHydrated, setIsHydrated] = useState<boolean>(() => !adapter);

  // biome-ignore lint/plugin: Load persisted panel state from adapter - async hydration pattern
  useEffect(() => {
    const loadFromAdapter = async () => {
      if (!adapter) {
        return;
      }
      try {
        const stored = await adapter.load();
        if (stored) {
          const loadedState: PanelPersistenceState = {
            showConsole: stored.showConsole ?? defaultShowConsole,
            showLeftPanel: stored.showLeftPanel ?? defaultShowLeftPanel,
            showRightPanel: stored.showRightPanel ?? defaultShowRightPanel,
            sizes: validateAndNormalizeSizes(stored.sizes ?? defaultSizes),
          };
          setState(loadedState);
          lastSavedStateRef.current = loadedState;
        }
      } catch (error) {
        // Deliberate degrade: a corrupted/unloadable persisted layout falls
        // back to defaults, but the discard is surfaced instead of silent.
        logger.warn('Failed to load persisted panel state; using defaults', {
          adapter: adapter.constructor?.name ?? 'unknown',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      setIsHydrated(true);
    };

    if (adapter) {
      void loadFromAdapter();
    }
  }, [defaultSizes, defaultShowConsole, defaultShowLeftPanel, defaultShowRightPanel, adapter]);

  return [state, setState, lastSavedStateRef, isHydrated];
}
