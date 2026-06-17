import { createLogger } from '@brainstrike/utils';
import { createContext, type ReactNode, use, useCallback, useMemo, useState } from 'react';
import {
  type AssistantDetailLevel,
  DEFAULT_ASSISTANT_DETAIL_LEVEL,
  isAssistantDetailLevel,
} from './assistant-detail-level';

const logger = createLogger('AssistantDetailLevel');

/**
 * localStorage key for the persisted Detail level. Factory Reset already covers
 * it via its blanket `localStorage.clear()` (no per-key enumeration); the export
 * is for tests and any future targeted handling.
 */
export const ASSISTANT_DETAIL_LEVEL_STORAGE_KEY = 'brainstrike.assistant.detail-level';

interface AssistantDetailLevelValue {
  detailLevel: AssistantDetailLevel;
  setDetailLevel: (level: AssistantDetailLevel) => void;
}

const FALLBACK_VALUE: AssistantDetailLevelValue = {
  detailLevel: DEFAULT_ASSISTANT_DETAIL_LEVEL,
  setDetailLevel: () => {
    /* no-op outside a provider */
  },
};

const AssistantDetailLevelContext = createContext<AssistantDetailLevelValue | null>(null);

function readStoredDetailLevel(): AssistantDetailLevel {
  if (typeof window === 'undefined') {
    return DEFAULT_ASSISTANT_DETAIL_LEVEL;
  }
  try {
    const stored = window.localStorage.getItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY);
    if (stored === null) {
      return DEFAULT_ASSISTANT_DETAIL_LEVEL;
    }
    if (isAssistantDetailLevel(stored)) {
      return stored;
    }
    // Corrupt value: surface it (no silent fallback) and reset to the default.
    logger.warn('Ignoring unrecognized persisted detail level', { stored });
    return DEFAULT_ASSISTANT_DETAIL_LEVEL;
  } catch (error) {
    logger.warn('Failed to read persisted detail level', { error });
    return DEFAULT_ASSISTANT_DETAIL_LEVEL;
  }
}

export function AssistantDetailLevelProvider({ children }: { children: ReactNode }) {
  const [detailLevel, setDetailLevelState] = useState<AssistantDetailLevel>(readStoredDetailLevel);

  const setDetailLevel = useCallback((level: AssistantDetailLevel) => {
    setDetailLevelState(level);
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY, level);
    } catch (error) {
      logger.warn('Failed to persist detail level', { error, level });
    }
  }, []);

  const value = useMemo<AssistantDetailLevelValue>(
    () => ({ detailLevel, setDetailLevel }),
    [detailLevel, setDetailLevel]
  );

  return (
    <AssistantDetailLevelContext.Provider value={value}>
      {children}
    </AssistantDetailLevelContext.Provider>
  );
}

/**
 * Read the active Detail level. Returns the `standard` default when no provider
 * is mounted (isolated component tests, non-panel usage) — a deliberate default,
 * not an error path.
 */
export function useAssistantDetailLevel(): AssistantDetailLevelValue {
  return use(AssistantDetailLevelContext) ?? FALLBACK_VALUE;
}
