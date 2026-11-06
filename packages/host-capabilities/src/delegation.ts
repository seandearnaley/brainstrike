/**
 * BST-1932: the shared Node host's delegation capability. The personas and limits
 * come from the same preferences and persona files the shipped assistant used
 * (request-personas.ts and user-personas-loader.ts, A26-A28): built-ins plus
 * each mounted root's and the home `.brainstrike/agents/` personas, less the
 * user's disabled ones, under the user's subagent settings. HostCore builds
 * and dispatches the `agent-<persona>` tools from it.
 */
import { homedir } from 'node:os';
import type { HostDelegation, HostDelegationModel } from '@brainstrike/agent-host';
import {
  type AssistantPersonaDefinition,
  BUILT_IN_PERSONAS,
  parseRuntimeSubagentSettings,
  type RuntimeSubagentSettings,
  type RuntimeWorkspaceRoot,
} from '@brainstrike/assistant-contract';
import {
  ChildModelError,
  childModelEfforts,
  childModelIdentity,
} from '@brainstrike/assistant-contract/child-model';
import {
  findLlmModelDefinition,
  resolveModelLabel,
} from '@brainstrike/assistant-contract/provider-registry';
import {
  createNodeFsScanDeps,
  scanUserPersonas,
  type UserSlashCommandScanRoot,
} from '@brainstrike/assistant-service/node-workspace-services';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('DesktopHostDelegation');

export interface HostSubagentsIntent {
  readonly delegationEnabled: boolean;
  readonly disabledPersonaIds: readonly string[];
  /** ADR-0037: the `provider::model` IDs a delegation may name. */
  readonly models?: readonly string[] | undefined;
  readonly settings: RuntimeSubagentSettings;
}

/**
 * The allowed models a delegation may name, as the catalog lists them. An ID
 * the catalog no longer lists is left out and logged: offering it would only
 * refuse every delegation that named it.
 */
function allowedModels(ids: readonly string[] | undefined): HostDelegationModel[] {
  return (ids ?? []).flatMap((id) => {
    try {
      const { model, provider } = childModelIdentity(id);
      if (!findLlmModelDefinition(provider, model)) {
        throw new ChildModelError(`${id} is not in the model catalog`);
      }
      return [
        {
          efforts: childModelEfforts(provider, model),
          id,
          label: resolveModelLabel(provider, model),
        },
      ];
    } catch (cause) {
      logger.warn('An allowed subagent model is not in the catalog; delegations cannot name it', {
        code: 'host_subagent_model_uncatalogued',
        errorName: cause instanceof Error ? cause.name : typeof cause,
      });
      return [];
    }
  });
}

export interface HostPersonaScan {
  scan(input: { readonly roots: readonly UserSlashCommandScanRoot[] }): {
    readonly personas: readonly AssistantPersonaDefinition[];
  };
}

/** The real persona files under each mounted root and the home directory. */
export const hostPersonaScan: HostPersonaScan = {
  scan: ({ roots }) => {
    const fs = createNodeFsScanDeps();
    try {
      return scanUserPersonas({ homeDir: homedir(), roots }, fs);
    } finally {
      fs.dispose();
    }
  },
};

export function resolveHostDelegation(
  intent: { readonly subagents?: HostSubagentsIntent | undefined },
  roots: readonly RuntimeWorkspaceRoot[],
  /** A plan-mode run only reads and proposes a plan; it never delegates. */
  planMode: boolean,
  personas: HostPersonaScan = hostPersonaScan
): HostDelegation | undefined {
  const subagents = intent.subagents;
  // A26: the master switch off or plan mode leaves no delegation tools.
  if (!subagents?.delegationEnabled || planMode) {
    return;
  }
  let scanned: readonly AssistantPersonaDefinition[] = [];
  try {
    scanned = personas.scan({
      roots: roots.map((root) => ({
        absPath: root.path,
        displayName: root.displayName,
        id: root.rootId,
      })),
    }).personas;
  } catch (cause) {
    // A27: a broken agents directory must not take down chat.
    logger.warn('User persona scan failed; continuing with built-in personas only', {
      code: 'host_user_persona_scan_failed',
      errorName: cause instanceof Error ? cause.name : typeof cause,
    });
  }
  const disabled = new Set(subagents.disabledPersonaIds);
  const models = allowedModels(subagents.models);
  return {
    ...(models.length > 0 ? { models } : {}),
    personas: [...BUILT_IN_PERSONAS, ...scanned].filter((persona) => !disabled.has(persona.id)),
    settings: parseRuntimeSubagentSettings(subagents.settings),
  };
}
