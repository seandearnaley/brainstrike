import type {
  AgentMessage,
  AssistantToolApprovalAction,
  AssistantToolResumeAction,
  RuntimeData,
  StreamChunk,
} from '@brainstrike/agent';
import {
  captureDelegatedSystemContext,
  streamMastraChildFollowup,
  streamMastraToolApprovalAction,
  streamMastraToolResumeAction,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import type { AssistantChildFollowupAction } from '@brainstrike/assistant-contract/child-followup';
import type { AssistantStreamRuntimeOptions } from './ports.js';
import type {
  AgentStreamCapabilities,
  AgentStreamCapabilityKinds,
  AgentStreamProviderApiKeyReader,
} from './stream-init.js';

/**
 * Pick the initial stream for the turn: approval-resume, suspend-resume
 * (submitPlan/askUser), or a fresh generation. Both resume paths skip
 * `injectReferencedFilesContext` — there is no new user turn to scan — mirroring
 * the approval path's contract.
 */
export async function resolveInitialAgentStream<K extends AgentStreamCapabilityKinds>(args: {
  deps: { readonly capabilities: AgentStreamCapabilities<K> };
  messages: AgentMessage[];
  runtime: RuntimeData;
  memoryOptions: AssistantStreamRuntimeOptions;
  resolvePersonaApiKey: AgentStreamProviderApiKeyReader;
  childFollowupAction?: AssistantChildFollowupAction | undefined;
  toolApprovalAction: AssistantToolApprovalAction | undefined;
  toolResumeAction: AssistantToolResumeAction | undefined;
}): Promise<AsyncIterable<StreamChunk>> {
  const {
    deps: { capabilities },
    messages,
    runtime,
    memoryOptions,
    resolvePersonaApiKey,
    childFollowupAction,
    toolApprovalAction,
    toolResumeAction,
  } = args;
  if (toolApprovalAction) {
    capabilities.runPersistence.recordContinuationRunTreatment?.(runtime);
    return streamMastraToolApprovalAction(toolApprovalAction, {
      ...memoryOptions,
      requireToolApproval: true,
      resolvePersonaApiKey,
      runtime,
    });
  }
  if (toolResumeAction) {
    capabilities.runPersistence.recordContinuationRunTreatment?.(runtime);
    return streamMastraToolResumeAction(toolResumeAction, {
      ...memoryOptions,
      resolvePersonaApiKey,
      runtime,
    });
  }
  // Prepend the turn's `@file` references (referenced-files), then any explicit
  // `:skill[name]` activations, then the opt-in self-improvement signal, then
  // the mounted roots' workspace instructions (AGENTS.md/AGENT.md/CLAUDE.md).
  // Instructions are applied LAST so the final front-to-back order is:
  // instructions → signal → skills → referenced files → conversation. All are
  // no-ops (same array identity) when nothing applies.
  const contextMessages: AgentMessage[] = childFollowupAction
    ? [
        ...messages.filter((message) => message.role === 'system'),
        {
          id: childFollowupAction.id,
          parts: [{ text: childFollowupAction.text, type: 'text' }],
          role: 'user',
        },
      ]
    : messages;
  const withReferencedFiles = await capabilities.contextInjectors.referencedFiles(
    contextMessages,
    runtime,
    capabilities.readWorkspaceTextFile
  );
  const withSkillActivations = await capabilities.contextInjectors.activatedSkills(
    withReferencedFiles,
    runtime.workspaceSkills
  );
  const withSelfImprovementSignal = await capabilities.contextInjectors.selfImprovementSignal(
    withSkillActivations,
    runtime
  );
  const contextualMessages = await capabilities.contextInjectors.workspaceInstructions(
    withSelfImprovementSignal,
    runtime,
    capabilities.readWorkspaceTextFile
  );
  if (childFollowupAction) {
    return streamMastraChildFollowup(childFollowupAction, {
      ...memoryOptions,
      getDelegatedSystemContext: () => captureDelegatedSystemContext(contextualMessages),
      resolvePersonaApiKey,
      runtime,
    });
  }
  return toAiSdkStyleStream(contextualMessages, runtime, memoryOptions);
}
