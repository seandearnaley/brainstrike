import type {
  AssistantPersonaAvailability,
  AssistantPersonaAvailabilityIssue,
  AssistantPersonaDefinition,
  ProviderCredential,
} from '@brainstrike/assistant-contract';
import {
  isDesktopNativeToolId,
  supportsWorkerPersonaProvider,
} from '@brainstrike/assistant-contract';
import { findProviderDefinition } from '@brainstrike/assistant-contract/provider-registry';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('PersonaAvailability');

export interface PersonaAvailabilityInputs {
  readonly mcpTools: ReadonlyMap<string, boolean>;
  readonly models: readonly {
    readonly id: string;
    readonly providerId: string;
    readonly type: string | null;
  }[];
  readonly readCredential: (provider: string) => Promise<ProviderCredential | undefined>;
}

/** Host preflight facts, not a prediction of a particular request's permissions. */
export async function inspectPersonaAvailability(
  persona: AssistantPersonaDefinition,
  inputs: PersonaAvailabilityInputs
): Promise<AssistantPersonaAvailability> {
  const issues: AssistantPersonaAvailabilityIssue[] = [];
  let blocked = false;
  const pin = persona.model;
  if (pin) {
    const definition = findProviderDefinition(pin.provider);
    const model = inputs.models.find(
      (entry) => entry.id === pin.modelId && entry.providerId === pin.provider
    );
    if (!definition?.capabilities.llm || model?.type === 'embedding') {
      blocked = true;
      issues.push({
        code: 'model-unsupported',
        message: `Model ${pin.provider}::${pin.modelId} cannot run an assistant. Select a language model from an LLM-capable provider in Models.`,
      });
    }
    if (!model) {
      issues.push({
        code: 'model-not-listed',
        message: `Model ${pin.provider}::${pin.modelId} is not in the host model catalog. Check its exact ID in Models or correct the profile.`,
      });
    }
    if (persona.mode === 'worker' && !supportsWorkerPersonaProvider(pin.provider)) {
      blocked = true;
      issues.push({
        code: 'worker-model-unsupported',
        message:
          'Worker mode cannot use the built-in local model. Select another model provider in this profile.',
      });
    }
    if (definition?.capabilities.llm && definition.authType !== 'none') {
      const issue = await inspectCredential(pin.provider, inputs.readCredential);
      if (issue) {
        blocked = true;
        issues.push(issue);
      }
    }
  }
  issues.push(...inspectDeclaredTools(persona.allowedToolIds, inputs.mcpTools));
  return {
    issues,
    status: blocked ? 'blocked' : issues.length > 0 ? 'needs-attention' : 'request-dependent',
  };
}

async function inspectCredential(
  provider: string,
  readCredential: PersonaAvailabilityInputs['readCredential']
): Promise<AssistantPersonaAvailabilityIssue | undefined> {
  try {
    if (await readCredential(provider)) {
      return undefined;
    }
    return { code: 'credential-missing', message: `Add credentials for ${provider} in Providers.` };
  } catch {
    logger.warn('Persona provider credentials could not be read', {
      code: 'persona_availability_credential_unreadable',
      provider,
    });
    return {
      code: 'credential-unreadable',
      message: `Credentials for ${provider} could not be read. Reconnect the provider in Providers.`,
    };
  }
}

function inspectDeclaredTools(
  allowedToolIds: readonly string[],
  mcpTools: ReadonlyMap<string, boolean>
): AssistantPersonaAvailabilityIssue[] {
  const issues: AssistantPersonaAvailabilityIssue[] = [];
  for (const toolId of allowedToolIds) {
    if (toolId === '*' || isDesktopNativeToolId(toolId)) {
      continue;
    }
    const enabled = mcpTools.get(toolId);
    if (enabled === undefined) {
      issues.push({
        code: 'tool-not-discovered',
        message: `Tool ${toolId} is not in the host’s current MCP catalog. Connect its server and check the exact tool ID in AI Tools.`,
        toolId,
      });
    } else if (!enabled) {
      issues.push({
        code: 'tool-disabled',
        message: `Tool ${toolId} is disabled. Enable it in AI Tools or remove it from the profile.`,
        toolId,
      });
    }
  }
  return issues;
}
