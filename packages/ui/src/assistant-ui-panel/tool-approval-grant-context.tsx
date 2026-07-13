import type { ToolRiskCategory } from '@brainstrike/assistant-contract/tool-metadata';
import { createContext, type ReactNode, use } from 'react';

/**
 * Grant actions the approval notice can offer BEYOND one-shot Approve/Decline.
 * The UI package stays presentational: the handlers are provided by the app
 * shell (which owns the permission-policy store) via
 * {@link ToolApprovalGrantProvider}, the same outside-in pattern as
 * `EditCheckpointProvider`. No provider (web, ungated hosts, tests) → the
 * notice renders no grant buttons — capability gating, not a disabled stub.
 */
export interface ToolApprovalGrantHandlers {
  /**
   * Promote `category` to allow for THIS SESSION only (cleared on reload).
   * Takes effect from the next assistant request; the pending call still
   * resolves through the normal approve resume.
   */
  readonly grantCategoryForSession: (category: ToolRiskCategory) => void;
  /** Persist an `allow` override for `toolId` that beats its category policy. */
  readonly grantToolAlways: (toolId: string) => void;
}

const ToolApprovalGrantContext = createContext<ToolApprovalGrantHandlers | null>(null);

export function ToolApprovalGrantProvider({
  handlers,
  children,
}: {
  handlers: ToolApprovalGrantHandlers | null;
  children: ReactNode;
}) {
  return (
    <ToolApprovalGrantContext.Provider value={handlers}>
      {children}
    </ToolApprovalGrantContext.Provider>
  );
}

/** The grant handlers, or `null` when no provider is mounted (render no buttons). */
export function useToolApprovalGrants(): ToolApprovalGrantHandlers | null {
  return use(ToolApprovalGrantContext);
}
