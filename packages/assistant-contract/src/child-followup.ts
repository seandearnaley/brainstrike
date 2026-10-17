import { Schema } from 'effect';
import { assistantChildInputSchema } from './child-input.js';
export const CHILD_FOLLOWUP_RUN_CONFIG_KEY = 'brainstrikeChildFollowup';
const identifier = Schema.String.pipe(Schema.decodeTo(Schema.Trim))
  .check(Schema.isMinCodePoints(1))
  .check(Schema.isMaxCodePoints(512));
export const childBranchSelectionSchema = Schema.Struct({
  kind: Schema.Literals(['retry', 'edit']),
  messageId: identifier,
});
export type ChildBranchSelection = Readonly<(typeof childBranchSelectionSchema)['Type']>;
const actionSchema = Schema.StructWithRest(assistantChildInputSchema, [
  Schema.Record(Schema.Literal('branch'), Schema.optional(childBranchSelectionSchema)),
  Schema.Record(Schema.Literal('threadId'), identifier),
]);
/** Only the selection and stable input ID cross the wire; the host resolves ownership. */
export type AssistantChildFollowupAction = Readonly<(typeof actionSchema)['Type']>;
export function readChildFollowupRunConfigAction(runConfig: unknown):
  | {
      readonly action: AssistantChildFollowupAction;
    }
  | {
      readonly invalid: true;
    }
  | undefined {
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
  const parsed = Schema.decodeUnknownResult(actionSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
  return parsed._tag === 'Success' ? { action: parsed.success } : { invalid: true };
}
export const CHILD_CONTINUATION_DATA_NAME = 'brainstrike.child-continuation';
/** No parent-tool coordinates: a human continuation is a new run of an existing child. */
export interface ChildContinuationStreamData {
  readonly baseline?: import('./delegated-conversation-stream.js').DelegatedConversationBaseline;
  readonly continuationId: string;
  readonly frames: readonly {
    readonly code: string;
    readonly value: unknown;
  }[];
  readonly messageId: string;
  readonly nativeRunId: string;
  readonly threadId: string;
}
