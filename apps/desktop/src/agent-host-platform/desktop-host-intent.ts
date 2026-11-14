import type { RuntimeData } from '@brainstrike/assistant-contract';
import type { AssistantThreadDraftRuntime } from '@brainstrike/assistant-data';
import { Schema } from 'effect';
import { PlatformClientConfigurationSchema } from './platform-client-configuration';
export type DesktopHostIntent = (typeof PlatformClientConfigurationSchema)['Type'];
export interface DesktopHostModelProjection {
  readonly agentLoop: RuntimeData['agentLoop'];
  readonly model: RuntimeData['model'];
  readonly modelSettings: RuntimeData['modelSettings'];
  readonly provider: RuntimeData['provider'];
  readonly providerOptions: RuntimeData['providerOptions'];
}
/** Existing owners prepare these inputs; this composition reads no settings or credentials. */
export interface DesktopHostIntentCapture {
  readonly agentLoop: RuntimeData['agentLoop'];
  readonly enabledNativeToolIds: readonly string[];
  readonly modelConfiguration: Pick<
    RuntimeData,
    'model' | 'modelSettings' | 'provider' | 'providerOptions'
  >;
  readonly permission: DesktopHostIntent['permissionPolicy'] & {
    readonly enforce: boolean;
  };
  readonly projection?: DesktopHostModelProjection | undefined;
  readonly selectionFolderId: string | null;
  readonly skillsPreference: RuntimeData['skillsPreference'];
  /** BST-1932: the user's subagent preferences; absent leaves the run without delegation. */
  readonly subagents?: DesktopHostIntent['subagents'];
  readonly threadDraft?:
    | Pick<AssistantThreadDraftRuntime, 'modelSettings' | 'providerOptions'>
    | undefined;
  readonly workspaceInstructionsPreference: DesktopHostIntent['workspaceInstructionsPreference'];
}
/** Keep the existing Send capture's precedence and strict non-secret wire shape. */
export function captureDesktopHostIntent(input: DesktopHostIntentCapture): DesktopHostIntent {
  const { autoReview, enforce, ...policy } = input.permission;
  const { projection, threadDraft } = input;
  return Schema.decodeUnknownSync(PlatformClientConfigurationSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })({
    agentLoop: input.agentLoop,
    enabledNativeToolIds: input.enabledNativeToolIds,
    modelConfiguration: {
      ...input.modelConfiguration,
      ...(projection ? { model: projection.model, provider: projection.provider } : {}),
      ...(threadDraft?.modelSettings ? { modelSettings: threadDraft.modelSettings } : {}),
      ...(threadDraft?.providerOptions ? { providerOptions: threadDraft.providerOptions } : {}),
      ...(projection?.modelSettings ? { modelSettings: projection.modelSettings } : {}),
      ...(projection?.providerOptions ? { providerOptions: projection.providerOptions } : {}),
    },
    // Enforcement off allows everything, so nothing is left for a reviewer.
    permissionPolicy: {
      ...policy,
      ...(enforce && autoReview ? { autoReview } : {}),
      yolo: policy.yolo || !enforce,
    },
    ...(input.selectionFolderId ? { selectionFolderId: input.selectionFolderId } : {}),
    skillsPreference: input.skillsPreference,
    ...(input.subagents ? { subagents: input.subagents } : {}),
    workspaceInstructionsPreference: input.workspaceInstructionsPreference,
  });
}
