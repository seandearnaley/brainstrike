import { usePermissionPolicyStore } from '@brainstrike/app-state/stores/permission-policy-store';
import type { ToolApprovalGrantHandlers } from '@brainstrike/assistant-ui';
import { useMemo } from 'react';

/**
 * Grant actions for the tool-approval notice ("Always allow" / "Allow
 * <category> this session"). Store-backed and stable: the request lifecycle
 * reads perToolOverrides/sessionGrants fresh at composition time, so a session
 * grant reaches the very next request and a saved override every request after
 * its save commits, without extra plumbing. Shared by the root chat panel
 * and the child conversation views, so a grant is offered wherever an
 * approval card can render (BST-1723, 2026-09-14).
 */
export function useToolApprovalGrantHandlers(): ToolApprovalGrantHandlers {
  return useMemo<ToolApprovalGrantHandlers>(
    () => ({
      grantAllToolsForSession: () =>
        usePermissionPolicyStore.getState().grantAllSessionCategories(),
      grantCategoryForSession: (category) =>
        usePermissionPolicyStore.getState().grantSessionCategory(category),
      grantToolAlways: (toolId) =>
        void usePermissionPolicyStore.getState().setToolOverride(toolId, 'allow'),
    }),
    []
  );
}
