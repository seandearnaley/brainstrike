import type { WorkspaceCollectionSyncBlockedReason } from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';

const MISSING_PROVIDER_KEY_MESSAGE_FRAGMENT = 'API key not configured';

export class WorkspaceIndexBlockedError extends Error {
  constructor(
    readonly blockedReason: WorkspaceCollectionSyncBlockedReason,
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceIndexBlockedError';
  }
}

export function isMissingProviderKeyMessage(message: string): boolean {
  return message.includes(MISSING_PROVIDER_KEY_MESSAGE_FRAGMENT);
}

export function isWorkspaceIndexBlockedError(error: unknown): error is WorkspaceIndexBlockedError {
  return error instanceof WorkspaceIndexBlockedError;
}
