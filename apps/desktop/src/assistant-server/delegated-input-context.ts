import {
  type AgentMessage,
  captureDelegatedSystemContext,
  type RuntimeData,
} from '@brainstrike/agent';
import {
  type AssistantChildInput,
  assertAssistantChildImageCapability,
  readAdmittedPersonaConfiguration,
} from '@brainstrike/assistant-contract';
import { readWorkspaceTextFile } from '@brainstrike/host-capabilities/native-tools';
import { buildReferencedFilesContextMessage } from './referenced-files-context';
import { injectActivatedSkillsContext } from './skills-activation-context';

/** Called only after the owning host resolves and authorizes the stored child. */
export function createDesktopDelegatedInputContext(runtime: RuntimeData | undefined) {
  return async (
    input: AssistantChildInput,
    configuration: unknown
  ): Promise<{ role: 'system'; content: string }[]> => {
    const persona = readAdmittedPersonaConfiguration(configuration);
    assertAssistantChildImageCapability(
      input,
      persona.model?.provider ?? runtime?.provider,
      persona.model?.modelId ?? runtime?.model
    );
    const context = await buildReferencedFilesContextMessage(
      input.text,
      runtime,
      readWorkspaceTextFile
    );
    const authored: AgentMessage = {
      id: input.id,
      parts: [{ text: input.text, type: 'text' }],
      role: 'user',
    };
    const contextual = await injectActivatedSkillsContext(
      context ? [context, authored] : [authored],
      runtime?.workspaceSkills
    );
    return captureDelegatedSystemContext(contextual).map((message) => {
      if (message.role !== 'system' || typeof message.content !== 'string') {
        throw new Error('Host child input context must contain only system text.');
      }
      return { content: message.content, role: 'system' };
    });
  };
}
