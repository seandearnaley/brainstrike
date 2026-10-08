import { resolvePermissionDecision } from '@brainstrike/assistant-contract';
import { modelMessageSchema, type StepResult, type ToolSet } from 'ai';
import { ApprovalInputReconstructionError, admittedApprovalInput } from './approval-input.js';
import type { HostRunState } from './core-state.js';
import { canonical, jsonValue } from './json-value.js';
import { McpAuthorityReconstructionError } from './mcp-authority.js';
import type {
  HostClientOrigin,
  HostPlatform,
  HostPreparedModelRequest,
  HostRunAdmission,
  HostRunAdmissionRequest,
  HostRunOwner,
} from './ports.js';
import type { HostEvent } from './protocol.js';
import { HostRunSnapshotSchema } from './protocol.js';
import { createHostSdkTools } from './sdk-tools.js';
import { bindHostRunWorkspace, validateHostRunWorkspaceBinding } from './workspace-state.js';

/** Provider instructions and public Memory context share the same SDK system input. */
export function combineHostSystemContext(
  provider: string | undefined,
  memory: string | undefined
): { readonly system?: string } {
  const sections = [provider, memory].filter((section): section is string => Boolean(section));
  return sections.length > 0 ? { system: sections.join('\n\n') } : {};
}

export function prepareHostProviderStep(
  provider: HostPreparedModelRequest,
  memorySystem: string | undefined,
  owner: HostRunOwner | undefined
): HostPreparedModelRequest {
  return {
    ...provider,
    model: owner?.prepareHostModel?.(provider.model) ?? provider.model,
    ...combineHostSystemContext(provider.system, memorySystem),
  };
}

export function assertHostRunStartAvailable(runs: Iterable<HostRunState>, threadId: string): void {
  for (const active of runs) {
    if (active.threadId === threadId && !active.terminal) {
      throw new Error('Thread already has an active root run');
    }
  }
}

/** Distinguish rejected selection from a resource owner that failed to join. */
export class HostRunAdmissionCleanupError extends AggregateError {
  constructor(cause: unknown, cleanup: unknown) {
    super([cause, cleanup], 'Run selection and cleanup failed');
    this.name = 'HostRunAdmissionCleanupError';
  }
}

/** A run owner's open acquired resources and then failed to join them. */
export class HostRunOwnerCleanupError extends AggregateError {
  constructor(cause: unknown, cleanup: unknown, message = 'Run owner open and cleanup failed') {
    super([cause, cleanup], message);
    this.name = 'HostRunOwnerCleanupError';
  }
}

/** Copy data records; credentials/functions and native capabilities stay process-local. */
function immutableData<T>(input: T): T {
  if (Array.isArray(input)) {
    return Object.freeze(input.map((value: unknown) => immutableData(value))) as T;
  }
  if (input === null || typeof input !== 'object') {
    return input;
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return input;
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(input).map(([key, value]: [string, unknown]) => [key, immutableData(value)])
    )
  ) as T;
}

/** Retain the selected executors and configuration without freezing the source registry. */
export function captureHostRunAdmission(selected: HostRunAdmission): HostRunAdmission {
  let closing: Promise<void> | undefined;
  const mcpAuthorities = Object.fromEntries(
    Object.entries(selected.tools).flatMap(([id, tool]) =>
      tool.mcpAuthority ? [[id, tool.mcpAuthority]] : []
    )
  );
  return Object.freeze({
    ...selected,
    ...(selected.close
      ? {
          close: (): Promise<void> =>
            (closing ??= Promise.resolve().then(() => selected.close?.())),
        }
      : {}),
    configuration: immutableData(selected.configuration),
    ...(selected.unavailableMcpServers
      ? {
          unavailableMcpServers: Object.freeze(
            selected.unavailableMcpServers.map(({ reason, serverId }) =>
              Object.freeze({ reason, serverId })
            )
          ),
        }
      : {}),
    ...(selected.provider
      ? { provider: Object.freeze({ prepare: selected.provider.prepare.bind(selected.provider) }) }
      : {}),
    snapshot: immutableData(
      HostRunSnapshotSchema.parse({
        ...selected.snapshot,
        ...(Object.keys(mcpAuthorities).length > 0 ? { mcpAuthorities } : {}),
      })
    ),
    tools: Object.freeze(
      Object.fromEntries(
        Object.entries(selected.tools).map(([id, binding]) => [id, Object.freeze({ ...binding })])
      )
    ),
  });
}

/** The run proceeds without each unavailable MCP server; its log names each one. */
export function hostMcpUnavailableEvents(
  admission: HostRunAdmission,
  runId: string
): Extract<HostEvent, { type: 'mcp.tools.unavailable' }>[] {
  return (admission.unavailableMcpServers ?? []).map(({ reason, serverId }) => ({
    reason,
    runId,
    serverId,
    type: 'mcp.tools.unavailable',
  }));
}

/** A new run command's admission request; only a live client supplies an origin. */
export function hostRunCommandRequest(
  params: {
    readonly configuration?: HostRunAdmissionRequest['configuration'] | undefined;
    readonly modelId: string;
    readonly threadId: string;
  },
  origin: HostClientOrigin | undefined,
  prompt: string,
  signal: AbortSignal
): Omit<HostRunAdmissionRequest, 'snapshot' | 'workspaceBinding'> {
  return {
    ...(params.configuration ? { configuration: params.configuration } : {}),
    modelId: params.modelId,
    ...(origin ? { origin } : {}),
    prompt,
    signal,
    threadId: params.threadId,
  };
}

export async function acquireHostRunAdmission(
  platform: HostPlatform,
  request: HostRunAdmissionRequest
): Promise<HostRunAdmission> {
  await validateHostRunWorkspaceBinding(platform, request);
  let selected: HostRunAdmission;
  if (platform.admitRun) {
    selected = await platform.admitRun(request);
  } else {
    const { maxSteps, resolveModel, tools } = platform;
    if (!(resolveModel && tools && maxSteps && Number.isSafeInteger(maxSteps) && maxSteps > 0)) {
      throw new Error('Host platform has no complete run admission capability');
    }
    selected = {
      configuration: {},
      ...(platform.generatesThreadTitles ? { generatesThreadTitle: true } : {}),
      model: await resolveModel.call(platform, request.modelId),
      snapshot: {
        configuration: {},
        maxSteps,
        toolIdentities: Object.fromEntries(
          Object.entries(tools).map(([id, binding]) => [id, binding.identity])
        ),
      },
      tools,
    };
  }
  try {
    await validateHostRunWorkspaceBinding(platform, request);
    const admission = captureHostRunAdmission(bindHostRunWorkspace(selected, request));
    const { snapshot, tools } = admission;
    if (
      request.snapshot &&
      Object.values(tools).some((tool) => tool.mcpAuthority?.kind === 'unavailable')
    ) {
      throw new McpAuthorityReconstructionError('private-comparison-unavailable');
    }
    if (
      canonical(jsonValue(snapshot.toolIdentities)) !==
      canonical(
        jsonValue(
          Object.fromEntries(Object.entries(tools).map(([id, tool]) => [id, tool.identity]))
        )
      )
    ) {
      throw new Error('Admitted tool catalog does not match its durable identities');
    }
    if (
      request.snapshot &&
      canonical(jsonValue(snapshot)) !== canonical(jsonValue(request.snapshot))
    ) {
      throw new ApprovalInputReconstructionError();
    }
    return admission;
  } catch (cause) {
    try {
      await selected.close?.();
    } catch (cleanup) {
      throw new HostRunAdmissionCleanupError(cause, cleanup);
    }
    throw cause;
  }
}

/** The Core retains this promise; both owners are attempted even when one join fails. */
export async function closeHostRunResources(run: HostRunState): Promise<void> {
  const joined = await Promise.allSettled([
    Promise.resolve(run.owner).then(
      (owner) => owner?.close(),
      (cause: unknown) => {
        // A failed or aborted open has nothing to close, and its failure is
        // already the run's outcome. Only an unjoined partial acquisition is a
        // cleanup failure; an admission's own failure stays with that branch.
        if (cause instanceof HostRunOwnerCleanupError) {
          throw cause;
        }
      }
    ),
    Promise.resolve(run.admissionTask ?? run.admission).then(
      (admission) => admission?.close?.(),
      (cause: unknown) => {
        // A rejected selection has already joined its acquired resources.
        if (cause instanceof HostRunAdmissionCleanupError) {
          throw cause;
        }
      }
    ),
  ]);
  const failures = joined.filter((result) => result.status === 'rejected');
  if (failures.length === 1) {
    throw failures[0]?.reason;
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Run resource cleanup failed'
    );
  }
}

export async function ensureHostRunAdmission(
  platform: HostPlatform,
  run: HostRunState
): Promise<HostRunAdmission> {
  const request: HostRunAdmissionRequest = {
    modelId: run.modelId,
    signal: run.controller.signal,
    ...(run.snapshot ? { snapshot: run.snapshot } : {}),
    ...(run.snapshot?.workspaceBinding ? { workspaceBinding: run.snapshot.workspaceBinding } : {}),
    threadId: run.threadId,
  };
  if (run.admission) {
    await validateHostRunWorkspaceBinding(platform, request);
    return run.admission;
  }
  run.admissionTask ??= acquireHostRunAdmission(platform, request).then((admission) => {
    run.admission = admission;
    return admission;
  });
  return run.admissionTask;
}

export function hostRunTools(run: HostRunState): HostRunAdmission['tools'] {
  if (!run.admission) {
    throw new Error('Run executors were not acquired');
  }
  return run.admission.tools;
}

/** A finished step's answerable approval requests, each bound to its registered tool. */
export function hostStepInteractions(
  run: HostRunState,
  content: StepResult<ToolSet>['content']
): Extract<HostEvent, { type: 'interaction.requested' }>[] {
  return content.flatMap((part) => {
    if (part.type !== 'tool-approval-request' || part.isAutomatic === true) {
      return [];
    }
    const registered = hostRunTools(run)[part.toolCall.toolName];
    if (!registered) {
      throw new Error('Approval references an unknown tool');
    }
    return [
      {
        input: jsonValue(part.toolCall.input),
        interactionId: part.approvalId,
        kind: registered.interaction?.kind ?? 'approval',
        ...(registered.interaction ? {} : { risk: registered.risk }),
        runId: run.id,
        ...(registered.permissionToolId ? { toolCatalogId: registered.permissionToolId } : {}),
        toolCallId: part.toolCall.toolCallId,
        toolId: part.toolCall.toolName,
        toolIdentity: registered.identity,
        type: 'interaction.requested',
      },
    ];
  });
}

/** Keep revocation live while taking risk and executor identity from admission. */
export async function hostRunToolDecision(
  platform: HostPlatform,
  run: HostRunState,
  toolId: string
): Promise<'allow' | 'ask' | 'deny'> {
  const registered = hostRunTools(run)[toolId];
  if (!registered) {
    throw new Error('Tool is not registered');
  }
  const snapshot = await platform.readPermissionPolicy(run.threadId);
  const permissionToolId = registered.permissionToolId ?? toolId;
  // ADR-0010: explicit deny outranks a session grant or YOLO.
  if (
    snapshot.perToolOverrides?.[permissionToolId] === 'deny' ||
    snapshot.policies[registered.risk] === 'deny'
  ) {
    return 'deny';
  }
  // The run's own committed grants add to the saved policy; deny already won.
  return resolvePermissionDecision({
    perToolOverrides: {
      ...snapshot.perToolOverrides,
      ...Object.fromEntries([...run.grants.tools].map((tool) => [tool, 'allow' as const])),
    },
    policies: snapshot.policies,
    riskCategory: registered.risk,
    sessionGrants: new Set([...(snapshot.sessionGrants ?? []), ...run.grants.categories]),
    toolId: permissionToolId,
    yolo: snapshot.yolo,
  });
}

/** Callbacks retain the existing Core writer and dispatcher; this owns no effects. */
export function createAdmittedHostSdkTools(
  run: HostRunState,
  dispatch: (
    action: Extract<HostEvent, { type: 'effect.started' }>,
    input: unknown
  ) => Promise<unknown>
): ToolSet {
  return createHostSdkTools({
    admittedInput: (id, input) => admittedApprovalInput(id, input, run),
    execute: (id, toolCallId, input) => {
      const action = run.permits.get(toolCallId);
      if (!action || action.toolId !== id) {
        throw new Error('Tool execution bypassed host permission admission');
      }
      if (canonical(jsonValue(input)) !== canonical(action.input)) {
        throw new Error('SDK execution input changed after permission admission');
      }
      return dispatch(action, input);
    },
    tools: hostRunTools(run),
  });
}

/** Uses the existing Core-owned run; permission calculation has no log writer. */
export async function decideHostSdkApproval(
  run: HostRunState,
  platform: HostPlatform,
  call: { toolName: string; toolCallId: string; input: unknown }
): Promise<'approved' | 'denied' | 'user-approval' | { type: 'denied'; reason: string }> {
  run.controller.signal.throwIfAborted();
  const registered = hostRunTools(run)[call.toolName];
  if (!registered) {
    throw new Error('Unknown tool');
  }
  const action: Extract<HostEvent, { type: 'effect.started' }> = {
    input: jsonValue(call.input),
    runId: run.id,
    ...(registered.permissionToolId ? { toolCatalogId: registered.permissionToolId } : {}),
    toolCallId: call.toolCallId,
    toolId: call.toolName,
    toolIdentity: registered.identity,
    type: 'effect.started',
  };
  const decision = await hostRunToolDecision(platform, run, call.toolName);
  run.controller.signal.throwIfAborted();
  const prior = [...run.approvals.values()].find(
    (approval) => approval.event.toolCallId === call.toolCallId
  );
  if (decision === 'deny' || prior?.decision === 'deny') {
    return 'denied';
  }
  // A PreToolUse hook refines a decision the policy allows or asks about; it
  // runs once per call, before any approval request.
  if (!prior && run.admission?.hooks) {
    const hooked = await run.admission.hooks.preToolUse({
      input: call.input,
      toolName: registered.permissionToolId ?? call.toolName,
    });
    run.controller.signal.throwIfAborted();
    if (hooked.blocked) {
      return { reason: hooked.reason, type: 'denied' };
    }
  }
  if (registered.interaction) {
    run.liveInputs.set(call.toolCallId, { value: call.input });
    return 'user-approval';
  }
  if (
    prior &&
    (prior.event.toolIdentity !== registered.identity ||
      canonical(prior.event.input) !== canonical(action.input))
  ) {
    throw new Error('Committed approval action identity changed');
  }
  if (decision === 'ask' && prior?.decision !== 'approve') {
    run.liveInputs.set(call.toolCallId, { value: call.input });
    return 'user-approval';
  }
  run.permits.set(call.toolCallId, action);
  return 'approved';
}

/** One model step and its answerable interactions, committed together by Core. */
export function hostModelStepEvents(run: HostRunState, step: StepResult<ToolSet>): HostEvent[] {
  return [
    {
      messages: step.response.messages.map((message) =>
        jsonValue(modelMessageSchema.parse(message))
      ),
      model: jsonValue(step.model),
      runId: run.id,
      stepNumber: run.steps,
      type: 'model.step',
      usage: jsonValue(step.usage),
    },
    ...hostStepInteractions(run, step.content),
  ];
}
