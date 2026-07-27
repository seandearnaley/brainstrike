import type { AssistantMemoryThread } from './assistant-memory-repository';
import type { ThreadListView } from './thread-list-sections';

export type ThreadPanelLoadState =
  | { readonly status: 'idle' | 'loading' | 'ready' }
  | { readonly error: string; readonly status: 'error' };

export type ThreadPanelContentState =
  | {
      readonly description: string;
      readonly kind: 'card';
      readonly testId: string;
      readonly title: string;
      readonly variant: 'error' | 'muted';
    }
  | { readonly kind: 'tree' };

/**
 * Decides what the panel body shows: the treegrid, or a state card in its place.
 *
 * Both the body and the toolbar read this. The toolbar's visible count and
 * select-visible toggle describe the treegrid, so they must withdraw whenever a
 * card stands in for it — otherwise the toolbar reports a count for rows that
 * are not on screen and offers to select threads the user cannot see.
 */
export function resolveThreadPanelContentState({
  databaseError,
  databaseStartupLoading,
  loadState,
  repositoryReady,
  threads,
  view,
}: {
  readonly databaseError: Error | null;
  readonly databaseStartupLoading: boolean;
  readonly loadState: ThreadPanelLoadState | null;
  readonly repositoryReady: boolean;
  readonly threads: readonly AssistantMemoryThread[];
  readonly view: ThreadListView;
}): ThreadPanelContentState {
  if (!repositoryReady) {
    if (databaseStartupLoading) {
      return {
        description: 'Reading Mastra memory from PGlite.',
        kind: 'card',
        testId: 'threads-loading-card',
        title: 'Loading threads...',
        variant: 'muted',
      };
    }
    if (databaseError) {
      return {
        description: databaseError.message,
        kind: 'card',
        testId: 'threads-error-card',
        title: 'Assistant memory database failed',
        variant: 'error',
      };
    }
    return {
      description: 'The assistant is unavailable until PGlite memory initializes.',
      kind: 'card',
      testId: 'threads-error-card',
      title: 'Assistant memory database unavailable',
      variant: 'error',
    };
  }
  if (loadState?.status === 'error') {
    return {
      description: loadState.error,
      kind: 'card',
      testId: 'threads-error-card',
      title: 'Failed to load threads',
      variant: 'error',
    };
  }
  if (loadState?.status === 'loading' && threads.length === 0) {
    return {
      description: 'Reading Mastra memory from PGlite.',
      kind: 'card',
      testId: 'threads-loading-card',
      title: 'Loading threads...',
      variant: 'muted',
    };
  }
  if (threads.length === 0 && view.kind === 'flat') {
    return {
      description: 'Create a new Mastra memory thread for this workspace.',
      kind: 'card',
      testId: 'threads-placeholder-card',
      title: 'No threads found',
      variant: 'muted',
    };
  }
  return { kind: 'tree' };
}
