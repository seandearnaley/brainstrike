import type { CollectionPickerCollection } from './types';

const WORKSPACE_INDEX_SYSTEM_ROLE = 'workspace-index';
const WORKSPACE_INDEX_BADGE_LABEL = 'Workspace index';
const WORKSPACE_INDEX_DISABLED_REASON = 'Managed by Brainstrike for assistant retrieval';

export interface CollectionPickerProtection {
  badgeLabel: string | null;
  canDelete: boolean;
  canEdit: boolean;
  canNormalSearchSelect: boolean;
  disabledReason: string | null;
  isDisabled: boolean;
  isWorkspaceIndex: boolean;
}

export function getCollectionPickerProtection(
  collection: CollectionPickerCollection
): CollectionPickerProtection {
  const isWorkspaceIndex = collection.systemRole === WORKSPACE_INDEX_SYSTEM_ROLE;
  const canNormalSearchSelect = collection.canNormalSearchSelect ?? !isWorkspaceIndex;
  const canEdit = collection.canEdit ?? !isWorkspaceIndex;
  const canDelete = collection.canDelete ?? !isWorkspaceIndex;
  const disabledReason =
    collection.disabledReason ??
    (isWorkspaceIndex && !canNormalSearchSelect ? WORKSPACE_INDEX_DISABLED_REASON : null);

  return {
    badgeLabel: isWorkspaceIndex ? WORKSPACE_INDEX_BADGE_LABEL : null,
    canDelete,
    canEdit,
    canNormalSearchSelect,
    disabledReason,
    isDisabled: !canNormalSearchSelect,
    isWorkspaceIndex,
  };
}
