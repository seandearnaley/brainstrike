/**
 * "Touched in this thread" (ADR-0021): a filter preset built from the active
 * thread's context rather than stored. It includes exactly the files the
 * thread's model received. It applies the files touched so far; pick it
 * again to take in files the thread touched since.
 */
import type { ViewFilterPreset } from '@brainstrike/types';
import { literalFilterPattern } from '@brainstrike/utils/path-filter';

export const THREAD_TOUCHED_PRESET_ID = 'thread:touched';

const BUILT_AT = new Date(0);

/** Null when the thread touched nothing: an empty include list would filter nothing. */
export function threadTouchedPreset(touchedPaths: readonly string[]): ViewFilterPreset | null {
  const fileCount = touchedPaths.length;
  if (fileCount === 0) {
    return null;
  }
  return {
    createdAt: BUILT_AT,
    description: `${fileCount.toLocaleString()} ${fileCount === 1 ? 'file' : 'files'} the thread's model received`,
    excludes: [],
    icon: 'file-text',
    id: THREAD_TOUCHED_PRESET_ID,
    includes: touchedPaths.map(literalFilterPattern),
    isDefault: true,
    name: 'Touched in this thread',
    sortOrder: -1,
    updatedAt: BUILT_AT,
    useRegex: false,
  };
}
