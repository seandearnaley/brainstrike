import {
  AdmittedChildConfigurationError,
  DELEGATION_LIMITS,
} from '@brainstrike/assistant-contract';
import type {
  AssistantPersonaDefinition,
  AssistantPersonaMode,
  AssistantPersonaSource,
} from '@brainstrike/assistant-contract/personas';
import { assertPersonaToolScope } from '@brainstrike/assistant-contract/personas';
import { findProviderDefinition } from '@brainstrike/assistant-contract/provider-registry';
import { z } from 'zod';
import type { MastraAgentRuntimeOptions } from './agent-runtime';
import type { DelegatedConversationBinding } from './delegated-conversation-binding';
import { PERSONA_PIN_KEYLESS_PROVIDERS } from './persona-pinned-model';

const nonempty = z.string().refine((value) => value.trim().length > 0);
const modes = { 'read-only': 'read-only', worker: 'worker' } as const satisfies {
  [Mode in AssistantPersonaMode]: Mode;
};
const sources = { 'built-in': 'built-in', user: 'user' } as const satisfies {
  [Source in AssistantPersonaSource]: Source;
};
// Required keys include optional contract fields: a new field must define its
// durable parser here instead of silently disappearing on resume.
const personaShape = {
  allowedToolIds: z.array(nonempty).min(1),
  description: nonempty,
  id: nonempty,
  instructions: nonempty,
  label: nonempty,
  maxSteps: z.number().int().min(1),
  mode: z.enum(modes).optional(),
  model: z
    .strictObject({
      modelId: nonempty,
      provider: nonempty.refine((provider) => findProviderDefinition(provider) !== undefined),
    })
    .optional(),
  source: z.enum(sources).optional(),
} satisfies {
  [Key in keyof Required<AssistantPersonaDefinition>]: z.ZodType<AssistantPersonaDefinition[Key]>;
};
const configurationSchema = z.strictObject({
  maxSteps: z.number().int().min(1).max(DELEGATION_LIMITS.maxChildSteps),
  persona: z.strictObject(personaShape),
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
    throw new AdmittedChildConfigurationError('host-capability-unavailable');
  }
  const scopes = await binding.resolveToolAction(action);
  if (scopes.length !== action.delegation.path.length || scopes.length === 0) {
    throw new AdmittedChildConfigurationError('ancestry-incomplete');
  }
  return scopes.map((scope, index) => {
    const parsed = configurationSchema.safeParse(scope.configuration);
    if (!parsed.success) {
      throw new AdmittedChildConfigurationError('invalid-configuration');
    }
    if (parsed.data.persona.id !== action.delegation?.path[index]?.personaId) {
      throw new AdmittedChildConfigurationError('identity-mismatch');
    }
    if (parsed.data.persona.allowedToolIds.includes('*')) {
      throw new AdmittedChildConfigurationError('catalog-unknown');
    }
    const { mode, model, source, ...definition } = parsed.data.persona;
    const persona: AssistantPersonaDefinition = {
      ...definition,
      maxSteps: parsed.data.maxSteps,
      ...(mode ? { mode } : {}),
      ...(model ? { model } : {}),
      ...(source ? { source } : {}),
    };
    try {
      assertPersonaToolScope(persona);
    } catch (cause) {
      throw new AdmittedChildConfigurationError('permission-scope-invalid', { cause });
    }
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
    runtime:
      Object.keys(keys).length > 0 || runtime.personaProviderApiKeys !== undefined
        ? { ...runtime, personaProviderApiKeys: keys }
        : runtime,
  };
}
