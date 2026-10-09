/**
 * BST-1932: the workspace tab address of an agent host child thread. The host
 * owns the child and its ancestry; the address only names which child to show
 * and the persona it runs, so a tab labels itself before the host answers.
 */
export interface HostChildWorkspaceTab {
  readonly persona: string;
  readonly threadId: string;
}

const PREFIX = 'host-child-thread:';

function requireTab(value: unknown): HostChildWorkspaceTab {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('Invalid child conversation tab address.');
  }
  const [threadId, persona]: unknown[] = value;
  if (
    typeof threadId !== 'string' ||
    !threadId.trim() ||
    typeof persona !== 'string' ||
    !persona.trim()
  ) {
    throw new Error('Invalid child conversation tab identity.');
  }
  return { persona, threadId };
}

export function hostChildWorkspaceTabId(tab: HostChildWorkspaceTab): string {
  const tuple = [tab.threadId, tab.persona];
  requireTab(tuple);
  return PREFIX + encodeURIComponent(JSON.stringify(tuple));
}

export function isHostChildWorkspaceTabId(id: string): boolean {
  return id.startsWith(PREFIX);
}

/** Ordinary app ids pass through; a corrupted child id is a visible error. */
export function readHostChildWorkspaceTab(id: string): HostChildWorkspaceTab | undefined {
  if (!id.startsWith(PREFIX)) {
    return;
  }
  return requireTab(JSON.parse(decodeURIComponent(id.slice(PREFIX.length))));
}
