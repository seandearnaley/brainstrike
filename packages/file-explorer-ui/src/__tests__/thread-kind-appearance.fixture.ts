import type { ExplorerThreadKindAppearance } from '../shell/explorer-thread-status';

/** The palette the app-shell publisher hands the explorer, as tests need it. */
export const THREAD_KIND_APPEARANCE: ExplorerThreadKindAppearance = {
  colorClass: {
    edit: 'text-green-800',
    grep: 'text-warning',
    pinned: 'text-pink-800',
    read: 'text-blue-700',
    semantic: 'text-purple-700',
  },
  label: {
    edit: 'Edited',
    grep: 'Grep hit',
    pinned: 'Attached by you',
    read: 'Read',
    semantic: 'Semantic hit',
  },
};
