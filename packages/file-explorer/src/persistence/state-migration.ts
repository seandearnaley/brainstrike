import type { SerializedState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';

type ZustandPersistWrapper<T> = { state?: T; version?: number };

const logger = createLogger('Persistence');

export function migrateState(
  rawPersistedState: unknown,
  version: number,
  shouldLog: boolean
): SerializedState {
  if (shouldLog) {
    logger.debug('Migrate - Received raw state:', rawPersistedState, 'Version:', version);
  }

  if (rawPersistedState === null || rawPersistedState === undefined) {
    if (shouldLog) {
      logger.debug('Migrate - No state (null or undefined), returning it as is.');
    }
    return rawPersistedState as unknown as SerializedState;
  }

  const wrapper = rawPersistedState as Partial<ZustandPersistWrapper<SerializedState>>;
  const stateToProcess =
    wrapper.state !== undefined ? wrapper.state : (rawPersistedState as SerializedState);

  if (stateToProcess === null || stateToProcess === undefined) {
    if (shouldLog) {
      logger.debug('Migrate - No actual state after unwrap (null/undefined), returning as is.');
    }
    return stateToProcess as unknown as SerializedState;
  }

  const serialized = stateToProcess as SerializedState;
  if (shouldLog) {
    logger.debug('Migrate - Returning valid SerializedState:', serialized);
  }
  return serialized;
}
