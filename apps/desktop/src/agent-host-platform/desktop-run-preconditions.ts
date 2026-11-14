import { isDeepStrictEqual } from 'node:util';
import { buildModelSettingsOption } from '@brainstrike/agent/provider-request';
import type { HostRunIntentRequest } from '@brainstrike/agent-host';
import {
  materializeCliWorkspaceIntent,
  readCliWorkspaceRunInput,
} from '@brainstrike/agent-host/standalone-workspace-input';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import {
  DEFAULT_PERMISSION_POLICIES,
  DESKTOP_NATIVE_TOOLS,
  deriveAgentLoopInputTokenLimit,
  findLlmModelDefinition,
  isSupportedProvider,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import { Schema } from 'effect';
import type { DesktopAdmissionReads } from './desktop-run-admission';
import {
  PlatformClientConfigurationSchema,
  type PlatformModelConfigurationSchema,
} from './platform-wire';
/** A desktop run's preconditions (BST-1930 stage e): the catalog model and the captured intent. */
export interface DesktopCatalogSelection {
  readonly definition: NonNullable<ReturnType<typeof findLlmModelDefinition>>;
  readonly model: string;
  readonly provider: SupportedProvider;
}
export function desktopInputTokenLimit(
  definition: DesktopCatalogSelection['definition'],
  intent: (typeof PlatformClientConfigurationSchema)['Type'],
  configuration: (typeof PlatformModelConfigurationSchema)['Type']
): number {
  const limit =
    intent.agentLoop?.inputTokenLimit ??
    deriveAgentLoopInputTokenLimit(
      definition,
      configuration.provider,
      configuration.modelSettings?.maxOutputTokens
    );
  if (!limit) {
    throw new Error('The selected model has no resolved input token budget');
  }
  return limit;
}
export async function readDesktopCatalogSelection(
  reads: DesktopAdmissionReads,
  modelId: string,
  signal: AbortSignal
): Promise<DesktopCatalogSelection> {
  const separator = modelId.indexOf('::');
  const provider = modelId.slice(0, separator);
  const model = modelId.slice(separator + 2);
  if (separator < 1 || !isSupportedProvider(provider)) {
    throw new Error('The selected model has no supported catalog identity');
  }
  // The UI composite is a selection key. The existing catalog owns the pair.
  const row = await reads.catalogModel({ model, provider }, signal);
  if (!row) {
    throw new Error('The selected model is not in the model catalog');
  }
  if (!row.isEnabled) {
    throw new Error('The selected catalog model is disabled');
  }
  if (row.providerId !== provider) {
    throw new Error('The selected model identity does not match its catalog provider');
  }
  const definition = findLlmModelDefinition(provider, model);
  if (!definition) {
    throw new Error('The selected catalog model has no resolved runtime budget');
  }
  return { definition, model, provider };
}
export async function readDesktopIntent(
  request: HostRunIntentRequest,
  catalog: DesktopCatalogSelection,
  readPersistedPolicy?: () => Promise<PermissionToolGateSnapshot | undefined>,
  readCliOwnerIntent?: DesktopAdmissionReads['cliOwnerIntent']
): Promise<(typeof PlatformClientConfigurationSchema)['Type']> {
  const workspaceInput = readCliWorkspaceRunInput(request.configuration);
  if (workspaceInput) {
    if (request.snapshot) {
      const committed = Schema.decodeUnknownSync(PlatformClientConfigurationSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(request.snapshot.configuration['intent']);
      if (!isDeepStrictEqual(committed.cliWorkspace, workspaceInput.workspace)) {
        throw new Error('CLI workspace recovery does not match its committed selection');
      }
      return committed;
    }
    // BST-1943: a subset envelope previously replaced settings with construction defaults.
    if (!readCliOwnerIntent) {
      throw new Error(
        '[ERR_CLI_WORKSPACE_OWNER_INTENT_UNAVAILABLE] CLI workspace reduction requires the existing full intent owner'
      );
    }
    request.signal.throwIfAborted();
    const ownerIntent = await readCliOwnerIntent(request);
    request.signal.throwIfAborted();
    if (ownerIntent === undefined || ownerIntent === null) {
      throw new Error(
        '[ERR_CLI_WORKSPACE_OWNER_INTENT_UNAVAILABLE] The full intent owner supplied no CLI intent'
      );
    }
    return Schema.decodeUnknownSync(PlatformClientConfigurationSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(
      materializeCliWorkspaceIntent(
        Schema.decodeUnknownSync(PlatformClientConfigurationSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(ownerIntent),
        workspaceInput.workspace
      )
    );
  }
  const captured = request.configuration ?? request.snapshot?.configuration['intent'];
  return Schema.decodeUnknownSync(PlatformClientConfigurationSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(
    captured ?? {
      enabledNativeToolIds: DESKTOP_NATIVE_TOOLS.map((tool) => tool.id),
      modelConfiguration: {
        model: catalog.model,
        provider: catalog.provider,
        ...buildModelSettingsOption({ model: catalog.model, provider: catalog.provider }),
      },
      permissionPolicy: (await readPersistedPolicy?.()) ?? {
        policies: DEFAULT_PERMISSION_POLICIES,
        yolo: false,
      },
      workspaceInstructionsPreference: { masterEnabled: true, oversizedOptInByRootId: {} },
    }
  );
}
