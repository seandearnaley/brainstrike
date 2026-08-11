import type { WorkspaceCollectionSyncBlockedReason } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';

export class WorkspaceIndexBlockedError extends Error {
  constructor(
    readonly blockedReason: WorkspaceCollectionSyncBlockedReason,
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceIndexBlockedError';
  }
}

export function isWorkspaceIndexBlockedError(error: unknown): error is WorkspaceIndexBlockedError {
  return error instanceof WorkspaceIndexBlockedError;
}
