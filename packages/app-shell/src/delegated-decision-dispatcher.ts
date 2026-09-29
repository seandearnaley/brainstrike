import type { DelegatedRunIdentity } from '@brainstrike/assistant-contract';
import { readToolApprovalRunConfigAction } from '@brainstrike/assistant-contract/tool-approval';
import { readToolResumeRunConfigAction } from '@brainstrike/assistant-contract/tool-suspend';
import type {
  AssistantConversationPanelProps,
  ChildContinuationIdentity,
  DelegatedConversationRuntimeOptions,
} from '@brainstrike/assistant-ui';

type AppendRoot = AssistantConversationPanelProps['runtime']['thread']['append'];

/** Decisions travel through the owning root; its runtime owns the appended row. */
export function createDelegatedDecisionDispatcher(
  identity:
    | (DelegatedRunIdentity & { readonly continuationId?: string })
    | ChildContinuationIdentity,
  appendRoot: AppendRoot
): DelegatedConversationRuntimeOptions['onNew'] {
  return async (message) => {
    const approval = readToolApprovalRunConfigAction(message.runConfig);
    const resume = readToolResumeRunConfigAction(message.runConfig);
    if (approval && resume) {
      throw new Error('A child message cannot contain two decisions.');
    }
    const result = approval ?? resume;
    if (!(result && 'action' in result)) {
      throw new Error('This child view accepts delegated decisions only.');
    }
    const matches =
      'nativeRunId' in identity
        ? result.action.continuationId === identity.continuationId &&
          result.action.runId === identity.nativeRunId
        : result.action.continuationId === identity.continuationId &&
          result.action.delegation?.path.some(
            (edge) =>
              edge.childRuntimeRunId === identity.childRuntimeRunId &&
              edge.parentRuntimeRunId === identity.parentRuntimeRunId &&
              edge.parentToolCallId === identity.parentToolCallId &&
              edge.personaId === identity.personaId
          );
    if (!matches) {
      throw new Error('The decision does not belong to this child conversation.');
    }
    // Child parent/source ids belong to a different message repository. Keeping
    // them would branch the root at a nonexistent row before its host can resume.
    await appendRoot({
      content: message.content,
      metadata: message.metadata,
      role: 'user',
      runConfig: message.runConfig,
      startRun: true,
    });
  };
}
