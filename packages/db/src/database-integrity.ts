import type { DatabaseIntegrityState } from '@brainstrike/types';

/**
 * Whether `background` database work may run in the given integrity state.
 *
 * The desktop main-process scheduler gate and the renderer-side hold both
 * decide through this one predicate, so a later `repairing` / `read-only`
 * state pauses background work everywhere by default instead of each surface
 * having to remember to add it. Only a healthy database admits background
 * writes.
 */
export function isBackgroundDatabaseWorkAdmitted(state: DatabaseIntegrityState): boolean {
  return state.kind === 'healthy';
}
