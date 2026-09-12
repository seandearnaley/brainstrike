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

export interface PersonaAvailabilityInputs {
  readonly mcpTools: ReadonlyMap<string, boolean>;
  readonly models: readonly { readonly id: string; readonly providerId: string }[];
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
    if (
      !inputs.models.some((model) => model.id === pin.modelId && model.providerId === pin.provider)
    ) {
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
    if (findProviderDefinition(pin.provider)?.authType !== 'none') {
      try {
        if (!(await inputs.readCredential(pin.provider))) {
          blocked = true;
          issues.push({
            code: 'credential-missing',
            message: `Add credentials for ${pin.provider} in Providers.`,
          });
        }
      } catch {
        blocked = true;
        issues.push({
          code: 'credential-unreadable',
          message: `Credentials for ${pin.provider} could not be read. Reconnect the provider in Providers.`,
        });
      }
    }
  }
  issues.push(...inspectDeclaredTools(persona.allowedToolIds, inputs.mcpTools));
  return {
    issues,
    status: blocked ? 'blocked' : issues.length > 0 ? 'needs-attention' : 'request-dependent',
  };
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
