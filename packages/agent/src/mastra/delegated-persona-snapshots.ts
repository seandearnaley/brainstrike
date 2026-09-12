import {
  AdmittedChildConfigurationError,
  readAdmittedPersonaConfiguration,
} from '@brainstrike/assistant-contract';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { MastraAgentRuntimeOptions } from './agent-runtime';
import type { DelegatedConversationBinding } from './delegated-conversation-binding';
import { PERSONA_PIN_KEYLESS_PROVIDERS } from './persona-pinned-model';

export { readAdmittedPersonaConfiguration } from '@brainstrike/assistant-contract';

type ToolAction = Parameters<NonNullable<DelegatedConversationBinding['resolveToolAction']>>[0];

/** Profiles come only from the host-authorized stored ancestry, never renderer data. */
export async function readDelegatedPersonaSnapshots(
  action: ToolAction,
  binding: DelegatedConversationBinding | undefined
): Promise<readonly AssistantPersonaDefinition[]> {
  if (!action.delegation) {
    return [];
  }
  if (!binding?.resolveToolAction) {
    throw new AdmittedChildConfigurationError('host-capability-unavailable');
  }
  const scopes = await binding.resolveToolAction(action);
  if (scopes.length !== action.delegation.path.length || scopes.length === 0) {
    throw new AdmittedChildConfigurationError('ancestry-incomplete');
  }
  return scopes.map((scope, index) =>
    readAdmittedPersonaConfiguration(scope.configuration, action.delegation?.path[index]?.personaId)
  );
}

/** The same persona id may have a different admitted configuration at each depth. */
export function personasAtDelegationDepth(
  personas: readonly AssistantPersonaDefinition[],
  snapshots: readonly AssistantPersonaDefinition[] | undefined,
  depth = 1
): readonly AssistantPersonaDefinition[] {
  const snapshot = snapshots?.[depth - 1];
  if (!snapshot) {
    return personas;
  }
  return personas.some((persona) => persona.id === snapshot.id)
    ? personas.map((persona) => (persona.id === snapshot.id ? snapshot : persona))
    : [...personas, snapshot];
}

/** Reacquire current credentials for admitted pins even when the live file was deleted. */
export async function withDelegatedPersonaSnapshots(
  action: ToolAction,
  options: MastraAgentRuntimeOptions
): Promise<MastraAgentRuntimeOptions> {
  const snapshots = await readDelegatedPersonaSnapshots(action, options.conversationBinding);
  return withAdmittedPersonaSnapshots(snapshots, options);
}

export async function withAdmittedPersonaSnapshots(
  snapshots: readonly AssistantPersonaDefinition[],
  options: MastraAgentRuntimeOptions
): Promise<MastraAgentRuntimeOptions> {
  if (snapshots.length === 0) {
    return options;
  }
  const runtime = options.runtime;
  if (!runtime) {
    throw new AdmittedChildConfigurationError('runtime-unavailable');
  }
  const keys = { ...runtime.personaProviderApiKeys };
  for (const persona of snapshots) {
    const provider = persona.model?.provider;
    if (
      !provider ||
      provider === runtime.provider ||
      PERSONA_PIN_KEYLESS_PROVIDERS.has(provider) ||
      keys[provider]
    ) {
      continue;
    }
    const key = await options.resolvePersonaApiKey?.(provider);
    if (key) {
      keys[provider] = key;
    }
  }
  return {
    ...options,
    delegatedPersonaSnapshots: snapshots,
    runtime:
      Object.keys(keys).length > 0 || runtime.personaProviderApiKeys !== undefined
        ? { ...runtime, personaProviderApiKeys: keys }
        : runtime,
  };
}
