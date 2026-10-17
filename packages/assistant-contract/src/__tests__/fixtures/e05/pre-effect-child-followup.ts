// Preconversion Zod oracle, test-only.
import { z } from 'zod';
import { assistantChildInputSchema } from './pre-effect-child-input.js';

export const CHILD_FOLLOWUP_RUN_CONFIG_KEY = 'brainstrikeChildFollowup';
const identifier = z.string().trim().min(1).max(512);
export const childBranchSelectionSchema = z.strictObject({
  kind: z.enum(['retry', 'edit']),
  messageId: identifier,
});
export type ChildBranchSelection = Readonly<z.output<typeof childBranchSelectionSchema>>;
const actionSchema = assistantChildInputSchema.safeExtend({
  branch: childBranchSelectionSchema.optional(),
  threadId: identifier,
});

/** Only the selection and stable input ID cross the wire; the host resolves ownership. */
export type AssistantChildFollowupAction = Readonly<z.output<typeof actionSchema>>;

export function readChildFollowupRunConfigAction(
  runConfig: unknown
): { readonly action: AssistantChildFollowupAction } | { readonly invalid: true } | undefined {
  if (!(runConfig && typeof runConfig === 'object' && Object.hasOwn(runConfig, 'custom'))) {
    return;
  }
  const custom = Reflect.get(runConfig, 'custom');
  if (
    !(custom && typeof custom === 'object' && Object.hasOwn(custom, CHILD_FOLLOWUP_RUN_CONFIG_KEY))
  ) {
    return;
  }
  const value: unknown = Reflect.get(custom, CHILD_FOLLOWUP_RUN_CONFIG_KEY);
  if (
    !(
      value &&
      typeof value === 'object' &&
      ['id', 'threadId', 'text'].every((key) => Object.hasOwn(value, key))
    )
  ) {
    return { invalid: true };
  }
  const parsed = actionSchema.safeParse(value);
  return parsed.success ? { action: parsed.data } : { invalid: true };
}

export const CHILD_CONTINUATION_DATA_NAME = 'brainstrike.child-continuation';
/** No parent-tool coordinates: a human continuation is a new run of an existing child. */
export interface ChildContinuationStreamData {
  readonly baseline?: import('./pre-effect-delegated-conversation-stream.js').DelegatedConversationBaseline;
  readonly continuationId: string;
  readonly frames: readonly { readonly code: string; readonly value: unknown }[];
  readonly messageId: string;
  readonly nativeRunId: string;
  readonly threadId: string;
}
