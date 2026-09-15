import type { AgentMessage, RuntimeData } from '../types';
import type { DelegatedPromptManifestRecord } from './delegated-conversation-binding';
import { captureDelegatedSystemContext } from './delegated-system-context';

/**
 * What a fresh root leg is told (swarm diagnostics, migration 139): the host
 * system messages — recorded ONCE per leg; child rows say `root-leg` instead
 * of repeating them (ruling 2) — the leg's model and the tools its Agent
 * registered. `undefined` without a memory thread: nothing durable to attach
 * the row to.
 */
export function buildRootLegPromptManifest(input: {
  readonly messages: readonly AgentMessage[];
  readonly registeredToolNames: readonly string[];
  readonly runtime: Pick<RuntimeData, 'memory' | 'model' | 'provider'> | undefined;
}): DelegatedPromptManifestRecord | undefined {
  const threadId = input.runtime?.memory?.threadId;
  if (!threadId) {
    return;
  }
  return {
    kind: 'root-leg',
    ...(input.runtime?.model ? { model: input.runtime.model } : {}),
    ...(input.runtime?.provider ? { provider: input.runtime.provider } : {}),
    systemContextSource: 'captured',
    systemMessages: captureDelegatedSystemContext(input.messages).map((message) => ({
      content: message.content,
      role: 'system' as const,
    })),
    threadId,
    toolNames: [...input.registeredToolNames],
  };
}
