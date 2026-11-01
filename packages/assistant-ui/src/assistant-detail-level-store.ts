import { createLogger } from '@brainstrike/logging';
import { persistDurable } from '@brainstrike/storage';
import { create } from 'zustand';
import {
  type AssistantDetailLevel,
  DEFAULT_ASSISTANT_DETAIL_LEVEL,
  isAssistantDetailLevel,
} from './assistant-detail-level.ts';

const logger = createLogger('AssistantDetailLevel');

/** The persisted Detail level; tests and E2E seeds write the same key. */
export const ASSISTANT_DETAIL_LEVEL_STORAGE_KEY = 'brainstrike:assistant-detail-level.v1';

interface AssistantDetailLevelState {
  readonly detailLevel: AssistantDetailLevel;
}

/**
 * The assistant's Detail level (`persistDurable`), read as the store is created,
 * so the first render already has it. A saved level this build does not know
 * is logged and the store opens on `standard`.
 */
export const useAssistantDetailLevelStore = create<AssistantDetailLevelState>()(
  persistDurable(
    ASSISTANT_DETAIL_LEVEL_STORAGE_KEY,
    (): AssistantDetailLevelState => ({ detailLevel: DEFAULT_ASSISTANT_DETAIL_LEVEL }),
    {
      merge: (saved, current) => {
        const detailLevel = (saved as Partial<Record<string, unknown>> | undefined)?.[
          'detailLevel'
        ];
        if (isAssistantDetailLevel(detailLevel)) {
          return { ...current, detailLevel };
        }
        if (detailLevel !== undefined) {
          logger.warn('Ignoring unrecognized persisted detail level', { stored: detailLevel });
        }
        return current;
      },
      version: 1,
    }
  )
);

export function setAssistantDetailLevel(detailLevel: AssistantDetailLevel): void {
  useAssistantDetailLevelStore.setState({ detailLevel });
}

/** The active Detail level and its setter. */
export function useAssistantDetailLevel(): {
  detailLevel: AssistantDetailLevel;
  setDetailLevel: (level: AssistantDetailLevel) => void;
} {
  const detailLevel = useAssistantDetailLevelStore((state) => state.detailLevel);
  return { detailLevel, setDetailLevel: setAssistantDetailLevel };
}
