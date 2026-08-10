import type { CollectionPickerCollection } from './types';

const WORKSPACE_INDEX_SYSTEM_ROLE = 'workspace-index';
const WORKSPACE_INDEX_BADGE_LABEL = 'Workspace index';
const WORKSPACE_INDEX_DISABLED_REASON = 'Managed by Brainstrike for assistant retrieval';
const DEFAULT_DISABLED_REASON = 'Selection is disabled for this collection';

export interface CollectionPickerProtection {
  badgeLabel: string | null;
  canDelete: boolean;
  canEdit: boolean;
  canNormalSearchSelect: boolean;
  disabledReason: string | null;
  isDisabled: boolean;
  isWorkspaceIndex: boolean;
  /** Non-null while edit/delete must be refused with a visible reason. */
  mutationBlockedReason: string | null;
}

export function getCollectionPickerProtection(
  collection: CollectionPickerCollection
): CollectionPickerProtection {
  const isWorkspaceIndex = collection.systemRole === WORKSPACE_INDEX_SYSTEM_ROLE;
  const canNormalSearchSelect = collection.canNormalSearchSelect ?? !isWorkspaceIndex;
  const mutationBlockedReason = collection.mutationBlockedReason ?? null;
  // A blocked mutation keeps its button RENDERED (disabled, with the reason in
  // the tooltip) rather than removing it, so the refusal is visible instead of
  // looking like the affordance never existed.
  const canEdit = collection.canEdit ?? !isWorkspaceIndex;
  const canDelete = collection.canDelete ?? !isWorkspaceIndex;
  let defaultDisabledReason: string | null = null;
  if (!canNormalSearchSelect) {
    defaultDisabledReason = isWorkspaceIndex
      ? WORKSPACE_INDEX_DISABLED_REASON
      : DEFAULT_DISABLED_REASON;
  }
  const disabledReason = collection.disabledReason ?? defaultDisabledReason;

  return {
    badgeLabel: isWorkspaceIndex ? WORKSPACE_INDEX_BADGE_LABEL : null,
    canDelete,
    canEdit,
    canNormalSearchSelect,
    disabledReason,
    isDisabled: !canNormalSearchSelect,
    isWorkspaceIndex,
    mutationBlockedReason,
  };
}
