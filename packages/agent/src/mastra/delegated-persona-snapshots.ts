import { DELEGATION_LIMITS } from '@brainstrike/assistant-contract';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { assertPersonaToolScope } from '@brainstrike/assistant-contract/personas';
import { z } from 'zod';
import type { MastraAgentRuntimeOptions } from './agent-runtime';
import type { DelegatedConversationBinding } from './delegated-conversation-binding';
import { PERSONA_PIN_KEYLESS_PROVIDERS } from './persona-pinned-model';

const nonempty = z.string().refine((value) => value.trim().length > 0);
const configurationSchema = z.object({
  maxSteps: z.number().int().min(1).max(DELEGATION_LIMITS.maxChildSteps),
  persona: z.object({
    allowedToolIds: z.array(nonempty),
    description: nonempty,
    id: nonempty,
    instructions: nonempty,
    label: nonempty,
    maxSteps: z.number().int().min(1),
    mode: z.enum(['read-only', 'worker']).optional(),
    model: z.object({ modelId: nonempty, provider: nonempty }).optional(),
    source: z.enum(['built-in', 'user']).optional(),
  }),
});

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
    throw new Error('Delegated persona restoration requires host-owned ancestry verification.');
  }
  const scopes = await binding.resolveToolAction(action);
  if (scopes.length !== action.delegation.path.length || scopes.length === 0) {
    throw new Error('Delegated persona restoration has incomplete authorized ancestry.');
  }
  return scopes.map((scope, index) => {
    const parsed = configurationSchema.safeParse(scope.configuration);
    if (!parsed.success || parsed.data.persona.id !== action.delegation?.path[index]?.personaId) {
      throw new Error(
        'The admitted child configuration is missing, invalid, or belongs to another persona.'
      );
    }
    if (parsed.data.persona.allowedToolIds.includes('*')) {
      throw new Error(
        'This older child configuration has no captured tool catalog. Start a new delegation to establish its permitted tools.'
      );
    }
    const { mode, model, source, ...definition } = parsed.data.persona;
    const persona: AssistantPersonaDefinition = {
      ...definition,
      maxSteps: parsed.data.maxSteps,
      ...(mode ? { mode } : {}),
      ...(model ? { model } : {}),
      ...(source ? { source } : {}),
    };
    assertPersonaToolScope(persona);
    return persona;
  });
}

/** The same persona id may have a different admitted configuration at each depth. */
export function personasAtDelegationDepth(
  personas: readonly AssistantPersonaDefinition[],
  snapshots: readonly AssistantPersonaDefinition[] | undefined,
  depth = 1
): readonly AssistantPersonaDefinition[] {
  const snapshot = snapshots?.[depth - 1];
  return snapshot
    ? [...personas.filter((persona) => persona.id !== snapshot.id), snapshot]
    : personas;
}

/** Reacquire current credentials for admitted pins even when the live file was deleted. */
export async function withDelegatedPersonaSnapshots(
  action: ToolAction,
  options: MastraAgentRuntimeOptions
): Promise<MastraAgentRuntimeOptions> {
  const snapshots = await readDelegatedPersonaSnapshots(action, options.conversationBinding);
  if (snapshots.length === 0) {
    return options;
  }
  const runtime = options.runtime;
  const keys = { ...runtime?.personaProviderApiKeys };
  for (const persona of snapshots) {
    const provider = persona.model?.provider;
    if (
      !provider ||
      provider === runtime?.provider ||
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
    ...(runtime ? { runtime: { ...runtime, personaProviderApiKeys: keys } } : {}),
  };
}
