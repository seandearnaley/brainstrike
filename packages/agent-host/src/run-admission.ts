import { modelStepFields } from '@brainstrike/agent/provider-runtime';
import { resolveRunPythonExecutionContext } from '@brainstrike/agent/tool-runtime';
import {
  type BoundaryFailure,
  intersectChildPermissionCeilings,
  isPermissionDenied,
  NATIVE_TOOL_ID,
  type PermissionToolGateSnapshot,
  resolvePermissionDecision,
} from '@brainstrike/assistant-contract';
import {
  type ToolRiskCategory,
  WEB_SEARCH_TOOL_ID,
} from '@brainstrike/assistant-contract/tool-metadata';
import type { StepResult, ToolSet } from 'ai';
import { Schema } from 'effect';
import { leaseHostAdmission } from './admission-lease.ts';
import { ApprovalInputReconstructionError, admittedApprovalInput } from './approval-input.ts';
import {
  type HostAutoReviewOutcome,
  hostAutoReviewTurns,
  reviewHostToolCall,
} from './auto-review.ts';
import {
  browserOriginDeniedReason,
  type HostBrowserOriginStore,
  readHostBrowserOrigins,
} from './browser-origin-answers.ts';
import { withHostDelegationTools } from './child-runs.ts';
import {
  createHostRunContext,
  type HostConsent,
  type HostRunState,
  type HostThreadGrants,
} from './core-state.ts';
import {
  defaultHostToolModelOutput,
  joinHostTurnStart,
  withHostToolHookContext,
} from './hook-context.ts';
import { canonical, jsonValue } from './json-value.ts';
import { McpAuthorityReconstructionError } from './mcp-authority.ts';
import type {
  HostClientOrigin,
  HostPlatform,
  HostPreparedModelRequest,
  HostRunAdmission,
  HostRunAdmissionRequest,
  HostRunIntentRequest,
  HostRunOwner,
  HostTool,
} from './ports.ts';
import type { HostEvent } from './protocol.ts';
import { HostRunSnapshotSchema } from './protocol.ts';
import { createHostSdkTools } from './sdk-tools.ts';
import { settleHostToolOutputs } from './tool-artifacts.ts';
import { bindHostRunWorkspace, validateHostRunWorkspaceBinding } from './workspace-state.ts';
/** Provider instructions and public Memory context share the same SDK system input. */
export function combineHostSystemContext(...context: readonly (string | undefined)[]): {
  readonly system?: string;
} {
  const sections = context.filter((section): section is string => Boolean(section));
  return sections.length > 0 ? { system: sections.join('\n\n') } : {};
}
export function prepareHostProviderStep(
  provider: HostPreparedModelRequest,
  memorySystem: string | undefined,
  owner: HostRunOwner | undefined,
  hookContext?: string
): HostPreparedModelRequest {
  return {
    ...provider,
    model: owner?.prepareHostModel?.(provider.model) ?? provider.model,
    // A UserPromptSubmit hook's context joins the run's instructions.
    ...combineHostSystemContext(provider.system, memorySystem, hookContext),
  };
}
/** Distinguish rejected selection from a resource owner that failed to join. */
export class HostRunAdmissionCleanupError extends AggregateError {
  constructor(cause: unknown, cleanup: unknown) {
    super([cause, cleanup], 'Run selection and cleanup failed');
    this.name = 'HostRunAdmissionCleanupError';
  }
}
/**
 * A run owner joined all of its work, and these failures are the run's outcome.
 * Only this releases a run whose owner close rejected; any other rejection is
 * opaque and keeps the run, its writer and Root owned.
 */
export class HostRunOwnerFailure extends AggregateError {
  readonly failure: BoundaryFailure | undefined;

  /**
   * @param failure - The outcome's typed failure, when its owner typed it
   *   (BST-2202); the joined failures stay the logged cause.
   */
  constructor(failures: readonly unknown[], message: string, failure?: BoundaryFailure) {
    super(failures, message);
    this.failure = failure;
    this.name = 'HostRunOwnerFailure';
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
function captureHostRunAdmission(selected: HostRunAdmission): HostRunAdmission {
  const mcpAuthorities = Object.fromEntries(
    Object.entries(selected.tools).flatMap(([id, tool]) =>
      tool.mcpAuthority ? [[id, tool.mcpAuthority]] : []
    )
  );
  const close = selected.close?.bind(selected);
  return Object.freeze({
    ...selected,
    // Children borrow this selection; it closes once, after its last holder.
    ...(close ? { close: leaseHostAdmission(close) } : {}),
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
      Schema.decodeSync(HostRunSnapshotSchema, { errors: 'all', onExcessProperty: 'error' })({
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
): Extract<
  HostEvent,
  {
    type: 'mcp.tools.unavailable';
  }
>[] {
  return (admission.unavailableMcpServers ?? []).map(({ reason, serverId }) => ({
    reason,
    runId,
    serverId,
    type: 'mcp.tools.unavailable',
  }));
}
/** What a new run command would be admitted with; only a live client supplies an origin. */
export function hostRunIntentRequest(
  params: {
    readonly configuration?: HostRunAdmissionRequest['configuration'] | undefined;
    readonly modelId: string;
    readonly planMode?: true | undefined;
    readonly threadId: string;
  },
  origin: HostClientOrigin | undefined,
  /** A command's user-written prompt; a wake (BST-1932) has none. */
  prompt: string | undefined,
  signal: AbortSignal
): Omit<HostRunIntentRequest, 'workspaceBinding'> {
  return {
    ...(params.configuration ? { configuration: params.configuration } : {}),
    modelId: params.modelId,
    ...(origin ? { origin } : {}),
    ...(params.planMode ? { planMode: true } : {}),
    ...(prompt === undefined ? {} : { prompt }),
    signal,
    threadId: params.threadId,
  };
}
/** A new run command's admission request: its intent, for the run being admitted. */
export function hostRunCommandRequest(
  params: Parameters<typeof hostRunIntentRequest>[0] & {
    readonly runId: string;
  },
  origin: HostClientOrigin | undefined,
  prompt: string | undefined,
  signal: AbortSignal
): Omit<HostRunAdmissionRequest, 'workspaceBinding'> {
  return { ...hostRunIntentRequest(params, origin, prompt, signal), runId: params.runId };
}
/** The platform's fixed default selection, for hosts without a per-run `admitRun`. */
async function defaultHostRunAdmission(
  platform: HostPlatform,
  request: HostRunAdmissionRequest
): Promise<HostRunAdmission> {
  const { delegation, maxSteps, resolveModel, tools } = platform;
  if (!(resolveModel && tools && maxSteps && Number.isSafeInteger(maxSteps) && maxSteps > 0)) {
    throw new Error('Host platform has no complete run admission capability');
  }
  const admitted = withHostDelegationTools(tools, delegation);
  return {
    configuration: {},
    ...(delegation ? { delegation } : {}),
    ...(platform.generatesThreadTitles ? { generatesThreadTitle: true } : {}),
    model: await resolveModel.call(platform, request.modelId),
    snapshot: {
      configuration: {},
      maxSteps,
      toolIdentities: Object.fromEntries(
        Object.entries(admitted).map(([id, binding]) => [id, binding.identity])
      ),
    },
    tools: admitted,
  };
}
export async function acquireHostRunAdmission(
  platform: HostPlatform,
  request: HostRunAdmissionRequest
): Promise<HostRunAdmission> {
  await validateHostRunWorkspaceBinding(platform, request);
  const selected = platform.admitRun
    ? await platform.admitRun(request)
    : await defaultHostRunAdmission(platform, request);
  try {
    await validateHostRunWorkspaceBinding(platform, request);
    const offered = omitDeniedHostTools(
      selected,
      await platform.readPermissionPolicy(request.threadId)
    );
    const admission = captureHostRunAdmission(bindHostRunWorkspace(offered, request));
    const { snapshot, tools } = admission;
    if (!admission.delegation && Object.values(tools).some((tool) => tool.delegation)) {
      throw new Error('Delegation tools were admitted without a delegation capability');
    }
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
    return await rejectHostRunSelection(selected, cause);
  }
}
/**
 * A tool the saved policy explicitly denies is not offered to the model or
 * admitted to the run. Recovery compares the result with the committed
 * selection, so a policy changed since admission interrupts rather than
 * substitutes.
 */
function omitDeniedHostTools(
  selected: HostRunAdmission,
  policy: PermissionToolGateSnapshot
): HostRunAdmission {
  const denied = new Set(
    Object.entries(selected.tools).flatMap(([id, tool]) =>
      isPermissionDenied(policy, tool.risk, tool.permissionToolId ?? id) ? [id] : []
    )
  );
  if (denied.size === 0) {
    return selected;
  }
  const kept = <T>(entries: Readonly<Record<string, T>>): Record<string, T> =>
    Object.fromEntries(Object.entries(entries).filter(([id]) => !denied.has(id)));
  return {
    ...selected,
    snapshot: { ...selected.snapshot, toolIdentities: kept(selected.snapshot.toolIdentities) },
    tools: kept(selected.tools),
  };
}
/** Join a selection that failed after acquisition, then rethrow its failure. */
async function rejectHostRunSelection(selected: HostRunAdmission, cause: unknown): Promise<never> {
  try {
    await selected.close?.();
  } catch (cleanup) {
    throw new HostRunAdmissionCleanupError(cause, cleanup);
  }
  throw cause;
}
/**
 * The run's owner (its public Memory), opened once over its admission. A run
 * whose owner close has begun is never reopened: Core releases a joined owner.
 */
export function openHostRunOwner(
  platform: HostPlatform,
  run: HostRunState,
  sources: {
    /** Core's sole writer, for the run's receipts. */
    readonly append: Parameters<typeof createHostRunContext>[1];
    readonly readCommittedRows: Parameters<typeof createHostRunContext>[2];
  }
): Promise<HostRunOwner | undefined> {
  if (run.ownerClose !== undefined) {
    return Promise.reject(new Error('The run owner is already closed'));
  }
  run.owner ??= ensureHostRunAdmission(platform, run).then((admission) => {
    const open = admission.openRun ?? platform.openRun?.bind(platform);
    return open?.({
      ...createHostRunContext(run, sources.append, sources.readCommittedRows),
      ...(admission.workingMemory === false ? { workingMemory: false as const } : {}),
    });
  });
  return run.owner;
}
/**
 * The owner's work joined before the run's end. Only an owner with a
 * foreground phase (`endTurn`) settles the rest after it; any other owner, a
 * failed open and a run without one join whole first, as every run did.
 */
export async function endHostRunTurn(
  run: HostRunState,
  closeOwner: (run: HostRunState) => Promise<void>
): Promise<void> {
  let owner: HostRunOwner | undefined;
  try {
    owner = await run.owner;
  } catch {
    return closeOwner(run);
  }
  if (!owner?.endTurn) {
    return closeOwner(run);
  }
  try {
    await owner.endTurn();
  } catch (cause) {
    if (!(cause instanceof HostRunOwnerFailure)) {
      throw cause;
    }
    run.ownerFailure ??= cause;
  }
}
/**
 * The Core retains this promise; both owners are attempted even when one join
 * fails. A joined failure after `run.finished` is the settlement's own fact.
 */
export async function closeHostRunResources(
  run: HostRunState,
  reportSettlementFailure: (failure: HostRunOwnerFailure) => Promise<void>
): Promise<void> {
  const joined = await Promise.allSettled([
    Promise.resolve(run.owner).then(
      async (owner) => {
        try {
          await owner?.close();
        } catch (cause) {
          // A joined failure (a failed memory step) is the run's outcome and
          // releases it; any other rejection keeps the run owned.
          if (!(cause instanceof HostRunOwnerFailure)) {
            throw cause;
          }
          if (run.terminal) {
            await reportSettlementFailure(cause);
          } else {
            run.ownerFailure ??= cause;
          }
        }
      },
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
  // Core keeps every run of the process; a joined owner (public Memory, its
  // observational memory and their WebAssembly hashers) must not outlive it.
  run.owner = undefined;
  run.ownerJoined = true;
}
/**
 * The run's admission as Core uses it: oversized tool outputs reach the model
 * as durable artifact pages over the committed output (legacy settlement), and
 * whether the provider's web search stands in for the catalog tool is fixed
 * once. Both admission paths (a new run and a re-admitted one) go through
 * here; each joins the selection if this throws.
 */
export async function bindHostRunAdmission(
  platform: HostPlatform,
  run: HostRunState,
  acquired: HostRunAdmission
): Promise<HostRunAdmission> {
  const admission = { ...acquired, tools: settleHostToolOutputs(run, acquired.tools) };
  run.nativeWebSearch = await admitHostNativeWebSearch(platform, run, admission);
  run.admission = admission;
  return admission;
}
/** The request that reopens a committed run's selection from its snapshot. */
export function hostRunReopenRequest(
  run: Pick<HostRunState, 'id' | 'modelId' | 'planMode' | 'snapshot' | 'threadId'>,
  signal: AbortSignal
): HostRunAdmissionRequest {
  return {
    modelId: run.modelId,
    ...(run.planMode ? { planMode: true } : {}),
    runId: run.id,
    signal,
    ...(run.snapshot ? { snapshot: run.snapshot } : {}),
    ...(run.snapshot?.workspaceBinding ? { workspaceBinding: run.snapshot.workspaceBinding } : {}),
    threadId: run.threadId,
  };
}
export async function ensureHostRunAdmission(
  platform: HostPlatform,
  run: HostRunState
): Promise<HostRunAdmission> {
  const request = hostRunReopenRequest(run, run.controller.signal);
  if (run.admission) {
    await validateHostRunWorkspaceBinding(platform, request);
    return run.admission;
  }
  run.admissionTask ??= acquireHostRunAdmission(platform, request).then((acquired) =>
    bindHostRunAdmission(platform, run, acquired).catch((cause: unknown) =>
      rejectHostRunSelection(acquired, cause)
    )
  );
  return run.admissionTask;
}
/** The catalog web search's provider tool name in this run's registry. */
function hostWebSearchToolId(admission: HostRunAdmission): string | undefined {
  return Object.entries(admission.tools).find(
    ([id, tool]) => (tool.permissionToolId ?? id) === WEB_SEARCH_TOOL_ID
  )?.[0];
}
/**
 * Decide once, at admission, whether the provider's own web search replaces
 * the catalog tool. Only an `allow` qualifies: a provider-executed tool runs
 * before any approval could pause it, so `ask` keeps the execute-backed tool
 * and `deny` leaves nothing to swap. A run carrying an approval of the catalog
 * tool also keeps it, so the answered call resumes against the same executor.
 */
async function admitHostNativeWebSearch(
  platform: HostPlatform,
  run: HostRunState,
  admission: HostRunAdmission
): Promise<HostRunState['nativeWebSearch']> {
  const tool = admission.nativeWebSearch;
  const toolId = hostWebSearchToolId(admission);
  if (!(tool && toolId)) {
    return;
  }
  if ([...run.approvals.values()].some((approval) => approval.event.toolId === toolId)) {
    return;
  }
  // The provider's search never passes an approval point, so a PreToolUse hook
  // on web search could not run; the catalog tool keeps it running per call.
  if (admission.hooks?.matchesPreToolUse(WEB_SEARCH_TOOL_ID)) {
    return;
  }
  const decision = await hostToolDecision(platform, run, admission.tools, toolId);
  return decision === 'allow' ? { tool, toolId } : undefined;
}
/**
 * A provider-executed tool has no execute for the per-call permission
 * re-check, so each step re-reads the live policy instead: once web search no
 * longer resolves to `allow`, the provider's tool leaves the step's tools.
 */
export async function hostStepActiveTools(
  run: HostRunState,
  platform: HostPlatform
): Promise<string[] | undefined> {
  const native = run.nativeWebSearch;
  const nativeAllowed =
    native !== undefined && (await hostRunToolDecision(platform, run, native.toolId)) === 'allow';
  // Hosted discovery: a deferred tool is offered once this run's branch committed its load.
  const discovered = await run.admission?.discovery?.activeTools({
    runId: run.id,
    threadId: run.threadId,
  });
  if (!discovered) {
    return !native || nativeAllowed
      ? undefined
      : Object.keys(hostRunTools(run)).filter((id) => id !== native.toolId);
  }
  if (!native) {
    return discovered;
  }
  // Legacy keeps the provider's own web search on the initial surface
  // (resolveToolDiscoverySurface); it leaves once it no longer resolves to allow.
  const surface = discovered.filter((id) => id !== native.toolId);
  return nativeAllowed ? [...surface, native.toolId] : surface;
}
export function hostRunTools(run: HostRunState): HostRunAdmission['tools'] {
  if (!run.admission) {
    throw new Error('Run executors were not acquired');
  }
  return run.admission.tools;
}
/** A finished step's answerable approval requests, each bound to its registered tool. */
function hostStepInteractions(
  run: HostRunState,
  content: StepResult<ToolSet>['content']
): Extract<
  HostEvent,
  {
    type: 'interaction.requested';
  }
>[] {
  return content.flatMap((part) => {
    if (part.type !== 'tool-approval-request' || part.isAutomatic === true) {
      return [];
    }
    const registered = hostRunTools(run)[part.toolCall.toolName];
    if (!registered) {
      throw new Error('Approval references an unknown tool');
    }
    const consent = run.consents.get(part.toolCall.toolCallId);
    // As the legacy approval chunk did: run_python's card shows host facts.
    const executionContext =
      registered.permissionToolId === NATIVE_TOOL_ID.runPython
        ? resolveRunPythonExecutionContext(part.toolCall.input)
        : undefined;
    const targetRoot = registered.approvalTarget?.(part.toolCall.input);
    const sandboxed = run.commandSandboxes.get(part.toolCall.toolCallId);
    return [
      {
        ...(executionContext ? { executionContext: jsonValue(executionContext) } : {}),
        input: jsonValue(part.toolCall.input),
        interactionId: part.approvalId,
        ...hostInteractionKind(registered, consent),
        // Auto access mode's note on why this call still asks.
        ...(part.reason ? { reason: part.reason } : {}),
        runId: run.id,
        ...(sandboxed === undefined ? {} : { sandboxed }),
        ...(targetRoot ? { targetRoot: { ...targetRoot } } : {}),
        ...(registered.permissionToolId ? { toolCatalogId: registered.permissionToolId } : {}),
        toolCallId: part.toolCall.toolCallId,
        toolId: part.toolCall.toolName,
        toolIdentity: registered.identity,
        type: 'interaction.requested',
      },
    ];
  });
}
/**
 * A request's kind, a network consent's browser origin, and the risk whose
 * grants it offers: a network consent offers them only where it also stands
 * in for an approval.
 */
function hostInteractionKind(
  registered: HostTool,
  consent: HostConsent | undefined
): Pick<Extract<HostEvent, { type: 'interaction.requested' }>, 'kind' | 'origin' | 'risk'> {
  return {
    kind: registered.interaction?.kind ?? (consent ? 'network' : 'approval'),
    ...(consent?.origin === undefined ? {} : { origin: consent.origin }),
    ...(registered.interaction || (consent && !consent.approval) ? {} : { risk: registered.risk }),
  };
}
/**
 * A person's per-call consent ahead of the policy's own ask: run_python's
 * requested network (legacy Gate B), or the first call to a browser origin
 * (BST-1178). The SDK gives a call one approval round, so this one card also
 * stands in for an approval the policy asks for; Core answers and executes it
 * on resume. A saved Don't allow refuses the call; a saved Always allow
 * leaves it to the policy.
 */
async function hostConsentDecision(
  run: HostRunState,
  registered: HostTool,
  call: { readonly input: unknown; readonly toolCallId: string },
  decision: 'allow' | 'ask',
  origins: HostBrowserOriginStore
): Promise<'user-approval' | { reason: string; type: 'denied' } | undefined> {
  let origin: string | undefined;
  if (!registered.consent?.(call.input)) {
    origin = registered.browserOrigin?.(call.input);
    if (origin === undefined) {
      return;
    }
    const saved = (await readHostBrowserOrigins(origins))[origin];
    run.controller.signal.throwIfAborted();
    if (saved === 'deny') {
      return { reason: browserOriginDeniedReason(origin), type: 'denied' };
    }
    if (saved === 'allow') {
      return;
    }
  }
  run.liveInputs.set(call.toolCallId, { value: call.input });
  run.consents.set(call.toolCallId, {
    approval: decision === 'ask',
    ...(origin === undefined ? {} : { origin }),
  });
  return 'user-approval';
}
/**
 * Discovery's own tools sit outside the permission catalog: legacy added them
 * after its permission gate, so its ask set never held them (approval-gate.ts).
 */
function isHostDiscoveryTool(run: HostRunState, toolId: string): boolean {
  return run.admission?.discovery?.toolIds.has(toolId) === true;
}
/** Keep revocation live while taking risk and executor identity from admission. */
export async function hostRunToolDecision(
  platform: HostPlatform,
  run: HostRunState,
  toolId: string
): Promise<'allow' | 'ask' | 'deny'> {
  return (await hostToolPolicy(platform, run, hostRunTools(run), toolId)).decision;
}
/**
 * Whether the live policy answers this call with no person: it allows the tool
 * and the call is not the person's own to approve (BST-2373). Full runs such a
 * call unasked, and so does a person's earlier session or tool grant given on
 * one of that tool's escapes in this root tree.
 */
export async function hostRunPolicyAnswers(
  platform: HostPlatform,
  run: HostRunState,
  call: { readonly input: unknown; readonly toolId: string }
): Promise<boolean> {
  const tools = hostRunTools(run);
  const { decision, yolo } = await hostToolPolicy(platform, run, tools, call.toolId);
  return (
    decision === 'allow' &&
    (yolo === true || !isPersonOnly(tools[call.toolId], call.input, run.grants))
  );
}
/** The person's own call, unless they already allowed such calls of its tool this session. */
function isPersonOnly(
  registered: HostTool | undefined,
  input: unknown,
  grants: HostThreadGrants
): boolean {
  return (
    registered?.personApproval?.(input) !== undefined &&
    !grants.outsideSandbox.has(registered.permissionToolId ?? '')
  );
}
/**
 * The policy's ask, or a call that is the person's own to approve: that asks
 * even where a policy grant or override allows its tool. Full runs it, and so
 * does a session or tool grant the person gave on an earlier escape of that
 * tool in this root tree, for the life of the process.
 */
function asksPerson(
  decision: 'allow' | 'ask',
  yolo: boolean | undefined,
  registered: HostTool,
  input: unknown,
  grants: HostThreadGrants
): boolean {
  return decision === 'ask' || (yolo !== true && isPersonOnly(registered, input, grants));
}
/** `tools` is passed because admission decides before it retains the run's tools. */
async function hostToolDecision(
  platform: HostPlatform,
  run: HostRunState,
  tools: HostRunAdmission['tools'],
  toolId: string
): Promise<'allow' | 'ask' | 'deny'> {
  return (await hostToolPolicy(platform, run, tools, toolId)).decision;
}
/** One tool's decision, and the live access mode's reviewer when one is on. */
async function hostToolPolicy(
  platform: HostPlatform,
  run: HostRunState,
  tools: HostRunAdmission['tools'],
  toolId: string
): Promise<{
  readonly autoReview?: PermissionToolGateSnapshot['autoReview'];
  readonly decision: 'allow' | 'ask' | 'deny';
  readonly yolo?: boolean;
}> {
  const registered = tools[toolId];
  if (!registered) {
    throw new Error('Tool is not registered');
  }
  if (isHostDiscoveryTool(run, toolId)) {
    return { decision: 'allow' };
  }
  // BST-1932: spawning never asks; every effect inside the child passes this gate itself.
  if (registered.delegation) {
    return { decision: 'allow' };
  }
  // A descendant follows its root's live policy and grants (it shares the root
  // thread's); only its admitted denies stay frozen (ADR-0010).
  const live = await platform.readPermissionPolicy(run.policyThreadId ?? run.threadId);
  const snapshot = run.admittedPolicy
    ? (intersectChildPermissionCeilings(run.admittedPolicy, live) ?? live)
    : live;
  return {
    ...(snapshot.autoReview ? { autoReview: snapshot.autoReview } : {}),
    decision: hostPolicyDecision(
      snapshot,
      run.grants,
      registered.risk,
      registered.permissionToolId ?? toolId
    ),
    // The ceiling folds Full into its decisions; the mode itself is the live root's.
    ...(live.yolo ? { yolo: true } : {}),
  };
}
/**
 * One tool's decision under the saved policy and its thread's grants: a deny
 * (the tool's own, or its category's) wins, and the grants add to the rest.
 * A model's call and an MCP App's own call of a tool are decided here alike.
 */
export function hostPolicyDecision(
  policy: PermissionToolGateSnapshot,
  grants: HostThreadGrants,
  risk: ToolRiskCategory,
  permissionToolId: string
): 'allow' | 'ask' | 'deny' {
  if (isPermissionDenied(policy, risk, permissionToolId)) {
    return 'deny';
  }
  return resolvePermissionDecision({
    perToolOverrides: {
      ...policy.perToolOverrides,
      ...Object.fromEntries([...grants.tools].map((tool) => [tool, 'allow' as const])),
    },
    policies: policy.policies,
    riskCategory: risk,
    sessionGrants: new Set([...(policy.sessionGrants ?? []), ...grants.categories]),
    toolId: permissionToolId,
    yolo: policy.yolo,
  });
}
/** Callbacks retain the existing Core writer and dispatcher; this owns no effects. */
export function createAdmittedHostSdkTools(
  run: HostRunState,
  dispatch: (
    action: Extract<
      HostEvent,
      {
        type: 'effect.started';
      }
    >,
    input: unknown
  ) => Promise<unknown>
): ToolSet {
  const tools = createHostSdkTools({
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
    // A PostToolUse hook's committed context is read beside the tool's result.
    modelOutput: async (id, options) => {
      const project = hostRunTools(run)[id]?.toModelOutput;
      return withHostToolHookContext(
        project ? await project(options) : defaultHostToolModelOutput(options.output),
        run.toolContexts.get(options.toolCallId)
      );
    },
    tools: hostRunTools(run),
  });
  const native = run.nativeWebSearch;
  return native ? { ...tools, [native.toolId]: native.tool } : tools;
}
/**
 * A call the policy asks about. Auto access mode's quick model answers first:
 * its approval permits the call, and whatever it does not approve asks the
 * user with its reason. A call that is the person's own to approve skips the
 * reviewer, as ADR-0031 has network consents do.
 */
async function hostAskDecision(
  run: HostRunState,
  registered: HostTool,
  call: { readonly input: unknown; readonly toolCallId: string; readonly toolName: string },
  action: Extract<HostEvent, { type: 'effect.started' }>,
  autoReview: PermissionToolGateSnapshot['autoReview'],
  /** A call already asked about is never reviewed again. */
  step: { readonly prior: unknown; readonly runs: ReadonlyMap<string, HostRunState> }
): Promise<'user-approval' | HostAutoReviewOutcome> {
  const reviewModel = run.admission?.reviewModel;
  const personOnly = registered.personApproval?.(call.input);
  let reviewed: HostAutoReviewOutcome | undefined;
  if (step.prior === undefined && personOnly !== undefined) {
    reviewed = { reason: personOnly, type: 'user-approval' };
  } else if (autoReview && step.prior === undefined) {
    reviewed = reviewModel
      ? await reviewHostToolCall({
          action: {
            input: call.input,
            risk: registered.risk,
            toolId: registered.permissionToolId ?? call.toolName,
          },
          model: () => reviewModel(autoReview.model),
          run,
          signal: run.controller.signal,
          turns: hostAutoReviewTurns(step.runs, run),
        })
      : {
          reason: 'Auto-review is not available for this run, so it needs your approval.',
          type: 'user-approval',
        };
    run.controller.signal.throwIfAborted();
  }
  if (reviewed?.type === 'approved') {
    run.permits.set(call.toolCallId, action);
    return reviewed;
  }
  if (registered.sandboxed) {
    run.commandSandboxes.set(call.toolCallId, await registered.sandboxed(call.input));
    run.controller.signal.throwIfAborted();
  }
  run.liveInputs.set(call.toolCallId, { value: call.input });
  return reviewed ?? 'user-approval';
}
/**
 * Uses the existing Core-owned run; permission calculation has no log writer.
 * `runs` are Core's committed runs, whose branches auto access mode reviews.
 */
export async function decideHostSdkApproval(
  run: HostRunState,
  platform: HostPlatform,
  origins: HostBrowserOriginStore,
  call: {
    toolName: string;
    toolCallId: string;
    input: unknown;
    providerExecuted?: boolean;
  },
  runs: ReadonlyMap<string, HostRunState>
): Promise<
  | 'approved'
  | 'denied'
  | 'not-applicable'
  | 'user-approval'
  | {
      type: 'approved' | 'denied' | 'user-approval';
      reason: string;
    }
> {
  // No tool acts before the workspace it may change is recorded.
  await joinHostTurnStart(run);
  run.controller.signal.throwIfAborted();
  // The provider already ran its own search; admission and each step's active
  // tools are its gate (hostStepActiveTools), never a decision after the fact.
  if (call.providerExecuted === true && call.toolName === run.nativeWebSearch?.toolId) {
    return 'not-applicable';
  }
  const registered = hostRunTools(run)[call.toolName];
  if (!registered) {
    throw new Error('Unknown tool');
  }
  const action: Extract<
    HostEvent,
    {
      type: 'effect.started';
    }
  > = {
    input: jsonValue(call.input),
    runId: run.id,
    ...(registered.permissionToolId ? { toolCatalogId: registered.permissionToolId } : {}),
    toolCallId: call.toolCallId,
    toolId: call.toolName,
    toolIdentity: registered.identity,
    type: 'effect.started',
  };
  // No policy decision, prompt or hook for discovery's own tools, as legacy.
  if (isHostDiscoveryTool(run, call.toolName)) {
    run.permits.set(call.toolCallId, action);
    return 'approved';
  }
  const { autoReview, decision, yolo } = await hostToolPolicy(
    platform,
    run,
    hostRunTools(run),
    call.toolName
  );
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
  const consented = prior
    ? undefined
    : await hostConsentDecision(run, registered, call, decision, origins);
  if (consented) {
    return consented;
  }
  if (
    asksPerson(decision, yolo, registered, call.input, run.grants) &&
    prior?.decision !== 'approve'
  ) {
    return await hostAskDecision(run, registered, call, action, autoReview, { prior, runs });
  }
  run.permits.set(call.toolCallId, action);
  return 'approved';
}
/** One model step and its answerable interactions, committed together by Core. */
export function hostModelStepEvents(run: HostRunState, step: StepResult<ToolSet>): HostEvent[] {
  // The same fields Hosted Web returns for a browser-recorded run (BST-1940).
  const { messages, model, usage } = modelStepFields(step);
  return [
    {
      messages: messages.map(jsonValue),
      model: jsonValue(model),
      runId: run.id,
      stepNumber: run.steps,
      type: 'model.step',
      usage: jsonValue(usage),
    },
    ...hostStepInteractions(run, step.content),
  ];
}
/** One committed admission batch; recovery reads the log rather than rereading references. */
export function hostReferencedFileEvents(admission: HostRunAdmission, runId: string): HostEvent[] {
  if (!admission.referencedFileFailures?.length) {
    return [];
  }
  return [{ files: [...admission.referencedFileFailures], runId, type: 'references.unavailable' }];
}
