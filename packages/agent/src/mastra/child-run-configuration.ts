import {
  type AssistantChildInput,
  admittedPersonaConfigurationSchema,
  assertAssistantChildImageCapability,
  type ChildExecutionConfiguration,
  childNextRunSchema,
  intersectChildPermissionCeilings,
  readAdmittedPersonaConfiguration,
  readChildExecutionConfiguration,
} from '@brainstrike/assistant-contract';
import type { PermissionToolGateSnapshot } from '../permissions/permission-tool-gate';
import type { RuntimeData } from '../types';
import type { MastraAgentRuntimeOptions } from './agent-runtime';
import {
  buildGenerationProviderOptionsOption,
  buildModelSettingsOption,
} from './runtime-assembly/stream-options';

/** Called inside the host's authorized admission transaction, before the receipt is created. */
export function configureChildContinuation(
  configuration: unknown,
  input: AssistantChildInput,
  options: MastraAgentRuntimeOptions
): unknown {
  const stored = admittedPersonaConfigurationSchema.parse(configuration);
  const persona = readAdmittedPersonaConfiguration(configuration);
  const runtime = options.runtime;
  if (!(runtime?.provider && runtime.model)) {
    throw new Error('Child configuration requires the authenticated root model.');
  }
  const next = input.nextRun ? childNextRunSchema.parse(input.nextRun) : undefined;
  const selected = next?.model ??
    persona.model ?? { modelId: runtime.model, provider: runtime.provider };
  assertAssistantChildImageCapability(input, selected.provider, selected.modelId);
  if (runtime.planMode && next?.planMode === false) {
    throw new Error('A child cannot disable the root plan mode.');
  }
  const disabled = new Set(next?.disabledToolIds ?? []);
  if ([...disabled].some((id) => !persona.allowedToolIds.includes(id))) {
    throw new Error('Child tool controls must refer to its admitted tool catalog.');
  }
  const allowedToolIds = persona.allowedToolIds.filter((id) => !disabled.has(id));
  if (allowedToolIds.length === 0) {
    throw new Error('The child requires at least one admitted tool.');
  }
  const sameModel = selected.provider === runtime.provider && selected.modelId === runtime.model;
  // Explicit controls contain canonical generation options. Inherited controls apply
  // only to the model they describe; a persona pin otherwise uses that model's defaults.
  const execution = readChildExecutionConfiguration({
    model: selected.modelId,
    provider: selected.provider,
    ...(sameModel ? buildModelSettingsOption(runtime) : {}),
    ...(sameModel ? buildGenerationProviderOptionsOption(runtime) : {}),
    ...(sameModel && runtime.requestedReasoningEffort
      ? { requestedReasoningEffort: runtime.requestedReasoningEffort }
      : {}),
    ...(next?.modelSettings ? { modelSettings: next.modelSettings } : {}),
    ...(next?.providerOptions ? { providerOptions: next.providerOptions } : {}),
    ...(next?.requestedReasoningEffort
      ? { requestedReasoningEffort: next.requestedReasoningEffort }
      : {}),
    permissionPolicy: intersectChildPermissionCeilings(
      stored.execution
        ? readChildExecutionConfiguration(stored.execution).permissionPolicy
        : undefined,
      options.permissionPolicy ?? runtime.permissionPolicy
    ),
    planMode: runtime.planMode === true || next?.planMode === true,
  });
  return {
    execution,
    maxSteps: stored.maxSteps,
    persona: { ...persona, allowedToolIds, model: selected },
  };
}

/** Legacy children have no fabricated execution facts; new receipts always have them. */
export function childContinuationExecution(
  configuration: unknown
): ChildExecutionConfiguration | undefined {
  const parsed = admittedPersonaConfigurationSchema.parse(configuration);
  return parsed.execution ? readChildExecutionConfiguration(parsed.execution) : undefined;
}

export function restoreChildExecution(
  configuration: unknown,
  options: MastraAgentRuntimeOptions
): MastraAgentRuntimeOptions {
  const execution = childContinuationExecution(configuration);
  if (!execution) {
    return options;
  }
  const permissionPolicy = intersectChildPermissionCeilings(
    execution.permissionPolicy,
    options.permissionPolicy ?? options.runtime?.permissionPolicy
  );
  const {
    modelSettings: _modelSettings,
    providerOptions,
    requestedReasoningEffort: _effort,
    ...runtime
  } = options.runtime ?? {};
  return {
    ...options,
    ...(permissionPolicy ? { permissionPolicy } : {}),
    childExecutionConfiguration: execution,
    runtime: {
      ...runtime,
      ...(execution.modelSettings ? { modelSettings: execution.modelSettings } : {}),
      providerOptions: {
        ...(providerOptions?.ollama ? { ollama: providerOptions.ollama } : {}),
        ...(providerOptions?.lmstudio ? { lmstudio: providerOptions.lmstudio } : {}),
        ...execution.providerOptions,
      },
      ...(execution.requestedReasoningEffort
        ? { requestedReasoningEffort: execution.requestedReasoningEffort }
        : {}),
      planMode: options.runtime?.planMode === true || execution.planMode,
      ...(permissionPolicy ? { permissionPolicy } : {}),
    },
  };
}

/** These generation options are also installed on the child Agent, not inferred from run metadata. */
export function captureRuntimeChildExecution(
  runtime: RuntimeData,
  provider: string,
  model: string,
  planMode: boolean,
  permissionPolicy: PermissionToolGateSnapshot | undefined,
  admitted?: ChildExecutionConfiguration,
  listingOnly = false
): ChildExecutionConfiguration | undefined {
  if (listingOnly) {
    return;
  }
  if (admitted) {
    return admitted;
  }
  return readChildExecutionConfiguration({
    model,
    permissionPolicy,
    planMode,
    provider,
    ...buildModelSettingsOption(runtime),
    ...buildGenerationProviderOptionsOption(runtime),
    ...(runtime.requestedReasoningEffort
      ? { requestedReasoningEffort: runtime.requestedReasoningEffort }
      : {}),
  });
}

/** A different pinned model starts with its own defaults; root-model options cannot describe it. */
export function executionForPersona(
  execution: ChildExecutionConfiguration | undefined,
  pin: { readonly provider: string; readonly modelId: string } | undefined
): ChildExecutionConfiguration | undefined {
  if (
    !(execution && pin) ||
    (execution.provider === pin.provider && execution.model === pin.modelId)
  ) {
    return execution;
  }
  return {
    model: pin.modelId,
    planMode: execution.planMode,
    provider: pin.provider,
    ...(execution.permissionPolicy ? { permissionPolicy: execution.permissionPolicy } : {}),
  };
}
