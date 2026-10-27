import type {
  AssistantMemoryThread,
  AssistantThreadMetadata,
} from './assistant-memory-repository.ts';
import type { ThreadFolderRow } from './thread-list-sections.ts';

/**
 * The thread a resource's new-thread composer stands for before it exists.
 * Nothing is created for it: its composer's choices (folder, checkout, model
 * settings) are held locally under this id until the first send creates the
 * thread, which then takes them.
 */
export function newThreadId(resourceId: string): string {
  return `new-thread:${resourceId}`;
}

export function isNewThreadId(threadId: string): boolean {
  return threadId.startsWith('new-thread:');
}

const UNSAVED = new Date(0);

/** The new thread as the workspace bar reads a thread: unsent, with its draft binding. */
export function newThread(
  resourceId: string,
  metadata: AssistantThreadMetadata | undefined
): AssistantMemoryThread {
  return {
    createdAt: UNSAVED,
    id: newThreadId(resourceId),
    ...(metadata ? { metadata } : {}),
    resourceId,
    title: 'New Thread',
    updatedAt: UNSAVED,
  };
}

/** A thread started from a folder starts bound to it. */
export function folderBinding(folder: ThreadFolderRow): AssistantThreadMetadata {
  return {
    operatingRootDisplayName: folder.displayName,
    operatingRootId: folder.rootId,
    ...(folder.path ? { operatingRootPath: folder.path } : {}),
  };
}
