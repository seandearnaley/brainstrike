import { Schema } from 'effect';

/**
 * BST-1990 (D4): the workspace folder a tool resolved for one call, so its
 * approval names the folder even when the call gave no `root`.
 */
export const HostApprovalTargetRootSchema = Schema.Struct({
  displayName: Schema.String.check(Schema.isMinCodePoints(1)),
  rootId: Schema.String.check(Schema.isMinCodePoints(1)),
});
export type HostApprovalTargetRoot = (typeof HostApprovalTargetRootSchema)['Type'];

/** The facts Core commits on a call's approval request, for its card. */
export const HOST_APPROVAL_FACT_FIELDS = {
  /** BST-2360: false when the approved command would run with no OS sandbox. */
  sandboxed: Schema.optional(Schema.Boolean),
  targetRoot: Schema.optional(HostApprovalTargetRootSchema),
};
