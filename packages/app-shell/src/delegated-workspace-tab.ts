export interface DelegatedWorkspaceTab {
  readonly ownerResourceId: string;
  readonly rootThreadId: string;
  readonly threadId: string;
}

const PREFIX = 'delegated-conversation:';

function requireTab(value: unknown): DelegatedWorkspaceTab {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error('Invalid delegated conversation tab address.');
  }
  const [ownerResourceId, rootThreadId, threadId]: unknown[] = value;
  if (
    typeof ownerResourceId !== 'string' ||
    !ownerResourceId.trim() ||
    typeof rootThreadId !== 'string' ||
    !rootThreadId.trim() ||
    typeof threadId !== 'string' ||
    !threadId.trim() ||
    rootThreadId === threadId
  ) {
    throw new Error('Invalid delegated conversation tab identity.');
  }
  return { ownerResourceId, rootThreadId, threadId };
}

/** An address only: the DB graph must authorize it before history is loaded. */
export function delegatedWorkspaceTabId(tab: DelegatedWorkspaceTab): string {
  const tuple = [tab.ownerResourceId, tab.rootThreadId, tab.threadId];
  requireTab(tuple);
  return PREFIX + encodeURIComponent(JSON.stringify(tuple));
}

/** Preserve ordinary app ids; corrupted child ids must produce visible errors. */
export function readDelegatedWorkspaceTab(id: string): DelegatedWorkspaceTab | undefined {
  if (!id.startsWith(PREFIX)) {
    return undefined;
  }
  return requireTab(JSON.parse(decodeURIComponent(id.slice(PREFIX.length))));
}
