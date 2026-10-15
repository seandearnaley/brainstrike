import type { RuntimeData } from '@brainstrike/assistant-contract';
import type { AssistantThreadDraftRuntime } from '@brainstrike/assistant-data';
import type { z } from 'zod';
import { PlatformClientConfigurationSchema } from './platform-client-configuration';

export type DesktopHostIntent = z.output<typeof PlatformClientConfigurationSchema>;

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
  readonly memoryOptions: NonNullable<RuntimeData['memory']>['memoryOptions'];
  readonly memorySettings: DesktopHostIntent['memorySettings'];
  readonly modelConfiguration: Pick<
    RuntimeData,
    'model' | 'modelSettings' | 'provider' | 'providerOptions'
  >;
  readonly permission: DesktopHostIntent['permissionPolicy'] & { readonly enforce: boolean };
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
  const { enforce, ...policy } = input.permission;
  const { projection, threadDraft } = input;
  return PlatformClientConfigurationSchema.parse({
    agentLoop: input.agentLoop,
    enabledNativeToolIds: input.enabledNativeToolIds,
    memoryOptions: input.memoryOptions,
    memorySettings: input.memorySettings,
    modelConfiguration: {
      ...input.modelConfiguration,
      ...(projection ? { model: projection.model, provider: projection.provider } : {}),
      ...(threadDraft?.modelSettings ? { modelSettings: threadDraft.modelSettings } : {}),
      ...(threadDraft?.providerOptions ? { providerOptions: threadDraft.providerOptions } : {}),
      ...(projection?.modelSettings ? { modelSettings: projection.modelSettings } : {}),
      ...(projection?.providerOptions ? { providerOptions: projection.providerOptions } : {}),
    },
    permissionPolicy: { ...policy, yolo: policy.yolo || !enforce },
    ...(input.selectionFolderId ? { selectionFolderId: input.selectionFolderId } : {}),
    skillsPreference: input.skillsPreference,
    ...(input.subagents ? { subagents: input.subagents } : {}),
    workspaceInstructionsPreference: input.workspaceInstructionsPreference,
  });
}
