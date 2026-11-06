import { randomUUID } from 'node:crypto';
import type { ApprovalFileChange, ToolRiskCategory } from '@brainstrike/assistant-contract';
import { describeBoundaryFailure, refusalError } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import {
  asSchema,
  type LanguageModel,
  type ModelMessage,
  modelMessageSchema,
  type ToolContent,
} from 'ai';
import { Schema } from 'effect';
import { ApprovalInputReconstructionError, validateApprovalInput } from './approval-input.ts';
import { toBoundaryFailure } from './boundary-wire.ts';
import {
  browserOriginDeniedReason,
  type HostBrowserOriginStore,
  saveHostBrowserOrigin,
} from './browser-origin-answers.ts';
import { hostTurnStopped } from './committed-identities.ts';
import type { HostRunExecutionPorts } from './core-run-execution.ts';
import {
  applyHostPermissionGrant,
  type HostRunMap,
  hasHostInteractionResponse,
  type PendingInteraction,
  type HostRunState as Run,
} from './core-state.ts';
import { executableInputSchema } from './executable-input-schema.ts';
import { defaultHostToolModelOutput, withHostToolHookContext } from './hook-context.ts';
import { jsonValue } from './json-value.ts';
import type { HostPlatform } from './ports.ts';
import {
  type HostEvent,
  type HostLogRow,
  HostNetworkConsentSchema,
  type HostParams,
  type HostPermissionGrant,
  type HostStepDelivery,
} from './protocol.ts';
import {
  ensureHostRunAdmission,
  hostRunPolicyAnswers,
  hostRunToolDecision,
  hostRunTools,
  outsideSandboxGrantKey,
} from './run-admission.ts';
import { type HostRunCarry, type HostRunPosition, hostStartPosition } from './run-branch.ts';

const logger = createLogger('AgentHost');

type Action = Extract<
  HostEvent,
  {
    type: 'effect.started';
  }
>;
type Interaction = Extract<
  HostEvent,
  {
    type: 'interaction.requested';
  }
>;
type Dispatch = (action: Action, input: unknown, resumeData?: unknown) => Promise<unknown>;
/** Core's platform, and its StateStore's saved browser origins (BST-1178). */
interface HostInteractionOwner {
  readonly origins: HostBrowserOriginStore;
  readonly platform: HostPlatform;
}
function decodeNetworkConsent(value: unknown): (typeof HostNetworkConsentSchema)['Type'] {
  return Schema.decodeUnknownSync(HostNetworkConsentSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
}
/**
 * BST-1178: the origin a committed Don't allow refused. Core settles that call
 * unrun itself; the browser tool never sees a refused call.
 */
function refusedHostOrigin(pending: PendingInteraction): string | undefined {
  const { event } = pending;
  if (
    event.kind !== 'network' ||
    event.origin === undefined ||
    !Object.hasOwn(pending, 'resumeData')
  ) {
    return;
  }
  return decodeNetworkConsent(pending.resumeData).action === 'deny' ? event.origin : undefined;
}
/** A card the policy answers with a person's saved origin answer. */
interface HostOriginPolicyAnswer {
  readonly pending: PendingInteraction;
  readonly resumeData: { readonly action: 'allow' | 'deny' };
}
/**
 * BST-1178: Always allow or Don't allow on a browser origin is saved before
 * the answer is accepted, so a save that fails refuses the answer rather than
 * losing it. The run's other cards for that origin (parallel calls in one
 * step) take the saved answer by policy: Don't allow settles each, Always
 * allow each that does not also stand in for an approval the policy asks for.
 */
async function rememberHostOrigin(
  origins: HostBrowserOriginStore,
  run: Run,
  pending: PendingInteraction,
  resumed: unknown
): Promise<readonly HostOriginPolicyAnswer[]> {
  const origin = pending.event.kind === 'network' ? pending.event.origin : undefined;
  if (origin === undefined) {
    return [];
  }
  const { action, remember } = decodeNetworkConsent(resumed);
  if (!remember) {
    return [];
  }
  await saveHostBrowserOrigin(origins, origin, action);
  return [...run.approvals.values()].flatMap((other) =>
    other !== pending &&
    other.event.kind === 'network' &&
    other.event.origin === origin &&
    !hasHostInteractionResponse(other) &&
    (action === 'deny' || other.event.risk === undefined)
      ? [{ pending: other, resumeData: { action } }]
      : []
  );
}
/** Core supplies the original append, boundary sync and fold, in that order. */
export async function commitHostModelMessages(
  run: Run,
  messages: readonly ModelMessage[],
  append: (event: HostEvent) => Promise<HostLogRow | undefined>,
  sync: () => Promise<void>,
  fold: (row: HostLogRow) => void,
  delivery?: HostStepDelivery
): Promise<void> {
  if (messages.length === 0) {
    return;
  }
  const row = await append({
    ...(delivery ? { delivery } : {}),
    messages: messages.map((message) => jsonValue(modelMessageSchema.parse(message))),
    runId: run.id,
    type: 'model.messages',
  });
  if (!row) {
    throw new Error('Model context was not committed');
  }
  await sync();
  fold(row);
}
/** The answered call's tool must be unchanged; any grant must match the call. */
function answeredGrant(
  run: Run,
  pending: PendingInteraction,
  grant: HostPermissionGrant | undefined,
  decision: 'approve' | 'deny'
): HostPermissionGrant | undefined {
  const registered = hostRunTools(run)[pending.event.toolId];
  if (!registered || registered.identity !== pending.event.toolIdentity) {
    throw new Error('Approval tool identity changed');
  }
  if (!grant) {
    return;
  }
  assertHostGrantMatchesCall(grant, decision, {
    risk: registered.risk,
    toolId: registered.permissionToolId ?? pending.event.toolId,
  });
  return grant;
}
/**
 * A resume's grant: only a network consent that stood in for an approval
 * (it carries the call's risk) may carry one, and, as legacy's approval grant
 * did, it covers running the tool, never its network.
 */
function resumedGrant(
  run: Run,
  pending: PendingInteraction,
  grant: HostPermissionGrant | undefined,
  resumed: unknown
): HostPermissionGrant | undefined {
  if (!grant) {
    return;
  }
  if (pending.event.kind !== 'network' || pending.event.risk === undefined) {
    throw new Error('Only a network consent that stood in for an approval carries a grant');
  }
  const { action } = decodeNetworkConsent(resumed);
  return answeredGrant(run, pending, grant, action === 'allow' ? 'approve' : 'deny');
}
/** The run's unanswered approval, or other interaction; anything else is stale. */
function unansweredHostInteraction(
  run: Run,
  interactionId: string,
  approval: boolean
): PendingInteraction {
  const pending = run.approvals.get(interactionId);
  if (
    run.terminal ||
    !pending ||
    (pending.event.kind === 'approval') !== approval ||
    hasHostInteractionResponse(pending)
  ) {
    throw refusalError(
      'conflict',
      'interaction.stale',
      approval
        ? 'Approval decision is stale or belongs to another run'
        : 'Human interaction is stale or belongs to another run'
    );
  }
  return pending;
}
/**
 * ADR-0036: the file change a waiting approval's call would make, from its
 * tool's own resolution and matcher. A read: nothing is written or committed.
 * It queues like an answer, so a closing or deleted thread refuses it.
 */
export function hostInteractionPreview(
  runs: Pick<HostRunMap, 'requireForThread'>,
  ports: () => Pick<HostRunExecutionPorts, 'admit' | 'platform'>
): (params: HostParams<'interaction/preview'>, signal: AbortSignal) => Promise<ApprovalFileChange> {
  return ({ interactionId, runId, threadId }, signal) => {
    const { admit, platform } = ports();
    return admit(
      threadId,
      async () => {
        const run = runs.requireForThread(threadId, runId);
        const pending = unansweredHostInteraction(run, interactionId, true);
        await ensureHostRunAdmission(platform, run);
        const registered = hostRunTools(run)[pending.event.toolId];
        if (!registered || registered.identity !== pending.event.toolIdentity) {
          throw new Error('Approval tool identity changed');
        }
        if (!registered.proposedChange) {
          throw refusalError(
            'input',
            'interaction.preview-unavailable',
            'This approval has no file change to preview'
          );
        }
        return await registered.proposedChange(pending.event.input, signal);
      },
      signal
    );
  };
}
/** Core supplies its sole acceptance writer and continuation owner. */
export async function commitHostInteractionResponse(
  run: Run,
  { origins, platform }: HostInteractionOwner,
  params: HostParams<'interaction/respond'> | HostParams<'interaction/resume'>,
  accept: (events: readonly HostEvent[]) => Promise<void>,
  continueRun: () => Promise<void>
): Promise<{
  accepted: true;
}> {
  const approval = 'decision' in params;
  const pending = unansweredHostInteraction(run, params.interactionId, approval);
  await ensureHostRunAdmission(platform, run);
  const resumed = approval
    ? undefined
    : await validateHostInteractionResume(run, pending, params.resumeData);
  const grant = approval
    ? answeredGrant(run, pending, params.grant, params.decision)
    : resumedGrant(run, pending, params.grant, resumed);
  const settled = approval ? [] : await rememberHostOrigin(origins, run, pending, resumed);
  await accept([
    ...(grant ? [{ grant, runId: run.id, type: 'permission.granted' as const }] : []),
    approval
      ? {
          decision: params.decision,
          interactionId: params.interactionId,
          runId: run.id,
          type: 'interaction.responded',
        }
      : {
          interactionId: params.interactionId,
          resumeData: params.resumeData,
          runId: run.id,
          type: 'interaction.responded',
        },
    ...settled.map(({ pending: other, resumeData }) => ({
      by: 'policy' as const,
      interactionId: other.event.interactionId,
      resumeData,
      runId: run.id,
      type: 'interaction.responded' as const,
    })),
  ]);
  if (grant) {
    applyHostPermissionGrant(run, grant);
    // A session grant given on a call that was the person's alone (a command
    // outside the sandbox) answers such calls of its tool for the session.
    const registered = hostRunTools(run)[pending.event.toolId];
    const approved = 'decision' in params && params.decision === 'approve';
    if (approved && registered?.personApproval?.(pending.event.input) !== undefined) {
      run.grants.outsideSandbox.add(outsideSandboxGrantKey(registered, pending.event.toolId));
    }
  }
  if (approval) {
    pending.decision = params.decision;
  } else {
    pending.resumeData = params.resumeData;
  }
  for (const { pending: other, resumeData } of settled) {
    other.resumeData = resumeData;
  }
  run.task = (run.task ?? Promise.resolve()).then(continueRun);
  run.task.catch(() => undefined);
  return { accepted: true };
}
/** A plan interaction's committed answer: the submitPlan resume shape. */
const PlanDecisionSchema = Schema.StructWithRest(
  Schema.Struct({
    action: Schema.Literals(['approved', 'rejected']),
    feedback: Schema.optional(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);
/** A plan-mode run's approved plan, once its plan interaction was answered with approval. */
function approvedHostPlan(run: Run):
  | {
      readonly feedback?: string;
    }
  | undefined {
  if (!run.planMode) {
    return;
  }
  for (const pending of run.approvals.values()) {
    if (pending.event.kind !== 'plan' || !Object.hasOwn(pending, 'resumeData')) {
      continue;
    }
    const { action, feedback } = Schema.decodeUnknownSync(PlanDecisionSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(pending.resumeData);
    if (action === 'approved') {
      return feedback ? { feedback } : {};
    }
  }
  return;
}
/** The follow-up `run/start` an approved plan continues with, out of plan mode. */
function approvedHostPlanRunParams(
  run: Run,
  plan: {
    readonly feedback?: string;
  }
): HostParams<'run/start'> {
  return {
    commandId: randomUUID(),
    ...(run.input?.configuration ? { configuration: run.input.configuration } : {}),
    modelId: run.modelId,
    parentMessageId: run.id,
    prompt: plan.feedback ? `Approved the plan.\n\n${plan.feedback}` : 'Approved the plan.',
    threadId: run.threadId,
  };
}
/** ADR-0028 step 3: the `run/start` that carries a run's task on in the worktree it entered. */
function enteredWorktreeRunParams(
  run: Run,
  worktree: NonNullable<Run['enteredWorktree']>
): HostParams<'run/start'> {
  const branch = worktree.branch ? ` on branch ${worktree.branch}` : '';
  return {
    commandId: randomUUID(),
    ...(run.input?.configuration ? { configuration: run.input.configuration } : {}),
    modelId: run.modelId,
    parentMessageId: run.id,
    prompt: `Continue the task in the worktree at ${worktree.path}${branch}. It is now this conversation's workspace.`,
    threadId: run.threadId,
  };
}
/**
 * The thread's next run, started by the host: an approved plan carried out,
 * a child's human input (BST-1932), or work moved into a worktree, which
 * carries on the turn of the run that entered it (`turnId`). `refused`
 * commits it as failed with that cause instead of starting it.
 */
export interface HostNextRun extends HostRunCarry {
  /**
   * The turn of the run this one carries on. A Stop of that turn committed
   * while this run waited to start refuses it at its admission, so it never
   * starts (`hostCarriedStartPosition`).
   */
  readonly follows?: string;
  readonly params: HostParams<'run/start'>;
  readonly refused?: Error;
}
/** A run carried on from a turn that a Stop ended while it waited: it starts nothing. */
export class HostTurnStoppedError extends Error {
  constructor(turnId: string) {
    super(`Turn ${turnId} was stopped before its next run started`);
    this.name = 'HostTurnStoppedError';
  }
}
/** A run/start's position; a carried-on run is admitted only while the turn it follows is not stopped. */
export function hostCarriedStartPosition(
  runs: ReadonlyMap<string, Run>,
  params: HostParams<'run/start'>,
  carry?: Pick<HostNextRun, 'follows' | 'hostPrompt' | 'turnId'>
): HostRunPosition {
  if (carry?.follows !== undefined && hostTurnStopped(runs, carry.follows)) {
    throw new HostTurnStoppedError(carry.follows);
  }
  return hostStartPosition(runs.values(), params, carry);
}
/**
 * The run the host starts to carry a completed run's task on: its approved
 * plan carried out, or the task in the worktree it entered, in the same turn
 * (`turnId`, ADR-0028 step 3).
 */
export function hostContinuationRun(run: Run, turnId: string): HostNextRun | undefined {
  const plan = approvedHostPlan(run);
  if (plan) {
    return { follows: turnId, params: approvedHostPlanRunParams(run, plan) };
  }
  return run.enteredWorktree
    ? // The host wrote this prompt: it is model input, never the person's words.
      {
        follows: turnId,
        hostPrompt: true,
        params: enteredWorktreeRunParams(run, run.enteredWorktree),
        turnId,
      }
    : undefined;
}
/**
 * Starts the thread's next run. A next run that cannot start is committed as
 * failed, with its cause, so it never ends silently.
 */
export async function startHostNextRun(
  runs: Iterable<Run>,
  { follows: _follows, params, refused, ...carry }: HostNextRun,
  start: () => Promise<unknown>,
  commitFailed: (runId: string, events: readonly HostEvent[]) => Promise<void>
): Promise<boolean> {
  try {
    if (refused) {
      throw refused;
    }
    await start();
    return true;
  } catch (cause) {
    // The person stopped the turn: nothing follows it, and nothing failed.
    if (cause instanceof HostTurnStoppedError) {
      return false;
    }
    const runId = randomUUID();
    await commitFailed(runId, failedHostStartEvents(runs, params, runId, cause, carry));
    return false;
  }
}
/** A next run that could not start, committed as started then failed with its cause. */
export function failedHostStartEvents(
  runs: Iterable<Run>,
  params: HostParams<'run/start'>,
  runId: string,
  cause: unknown,
  carry?: HostRunCarry
): HostEvent[] {
  return [
    {
      ...hostStartPosition(runs, params, carry),
      modelId: params.modelId,
      runId,
      type: 'run.started',
    },
    {
      detail: describeBoundaryFailure(
        toBoundaryFailure(cause, (message, fields) =>
          logger.error(message, { ...fields, runId, threadId: params.threadId })
        )
      ),
      outcome: 'failed',
      runId,
      type: 'run.finished',
    },
  ];
}
/** A continuation that threw ends its run: stopped, interrupted on lost approval input, or failed. */
function hostContinuationFailure(
  run: Run,
  cause: unknown
): {
  readonly detail: string;
  readonly outcome: Extract<
    HostEvent,
    {
      type: 'run.finished';
    }
  >['outcome'];
} {
  const outcome = run.stopped
    ? 'stopped'
    : cause instanceof ApprovalInputReconstructionError
      ? 'interrupted'
      : 'failed';
  return {
    detail: describeBoundaryFailure(
      toBoundaryFailure(cause, (message, fields) =>
        logger.error(message, { ...fields, runId: run.id, threadId: run.threadId })
      )
    ),
    outcome,
  };
}
/** A grant names exactly the approved call's own risk category or tool, never another. */
function assertHostGrantMatchesCall(
  grant: HostPermissionGrant,
  decision: 'approve' | 'deny',
  call: {
    readonly risk: ToolRiskCategory;
    readonly toolId: string;
  }
): void {
  const matches =
    grant.scope === 'session' ? grant.category === call.risk : grant.toolId === call.toolId;
  if (decision !== 'approve' || !matches) {
    throw new Error('Permission grant does not match the approved call');
  }
}
/**
 * ADR-0010 (AT-03, AT-22): after a decision lands, a still-pending approval the
 * root's live policy now allows (a session grant, a per-tool allow) is answered
 * by that policy, recorded as such, and its run continues. Anything the policy
 * still asks about waits for a person (BST-1932).
 */
export async function approveHostRunByPolicy(
  run: Run,
  owner: HostInteractionOwner,
  interactionId: string,
  append: (events: readonly HostEvent[]) => Promise<unknown>,
  continueRun: () => Promise<void>
): Promise<void> {
  const pending = run.approvals.get(interactionId);
  if (
    run.terminal ||
    !pending ||
    pending.event.kind !== 'approval' ||
    hasHostInteractionResponse(pending) ||
    !(await hostRunPolicyAnswers(owner.platform, run, pending.event))
  ) {
    return;
  }
  await commitHostInteractionResponse(
    run,
    owner,
    {
      commandId: interactionId,
      decision: 'approve',
      interactionId,
      runId: run.id,
      threadId: run.threadId,
    },
    async (events) => {
      await append(
        events.map((event) =>
          event.type === 'interaction.responded' ? { ...event, by: 'policy' as const } : event
        )
      );
    },
    continueRun
  );
}
// Continuation calculations reuse Core's owned run and dispatch; no log writer lives here.
async function validateHostInteractionResume(
  run: Run,
  pending: PendingInteraction,
  value: unknown
): Promise<unknown> {
  const tool = hostRunTools(run)[pending.event.toolId];
  if (pending.event.kind === 'network') {
    if (
      !(tool && (tool.consent || tool.browserOrigin)) ||
      tool.identity !== pending.event.toolIdentity
    ) {
      throw new Error('Network consent tool identity changed');
    }
    const consent = decodeNetworkConsent(value);
    // run_python's network is asked per call, never remembered.
    if (consent.remember && pending.event.origin === undefined) {
      throw new Error("Only a browser origin's consent is remembered");
    }
    return consent;
  }
  if (
    !tool ||
    tool.identity !== pending.event.toolIdentity ||
    tool.interaction?.kind !== pending.event.kind
  ) {
    throw new Error('Human interaction tool identity changed');
  }
  const validator = asSchema(executableInputSchema(tool.interaction.resumeSchema)).validate;
  if (!validator) {
    throw new Error('Human interaction has no executable resume validator');
  }
  const result = await validator(value);
  if (!result.success) {
    throw result.error;
  }
  return result.value;
}
export async function resolveHostApprovalInput(run: Run, event: Interaction): Promise<unknown> {
  const approval = run.approvals.get(event.interactionId);
  if (!approval) {
    throw refusalError('input', 'interaction.unknown', 'Unknown approval occurrence');
  }
  const registered = hostRunTools(run)[event.toolId];
  if (!registered || registered.identity !== event.toolIdentity) {
    throw new Error('Approval tool identity changed');
  }
  approval.runtimeInput ??= {
    value: await validateApprovalInput(registered, event, run.rawInputs),
  };
  return approval.runtimeInput.value;
}
async function modelResult(
  run: Run,
  toolCallId: string,
  toolId: string,
  input: unknown,
  output: unknown
): Promise<ToolContent[number]> {
  const project = hostRunTools(run)[toolId]?.toModelOutput;
  return {
    // A PostToolUse hook's committed context is read beside the tool's result.
    output: withHostToolHookContext(
      project ? await project({ input, output, toolCallId }) : defaultHostToolModelOutput(output),
      run.toolContexts.get(toolCallId)
    ),
    toolCallId,
    toolName: toolId,
    type: 'tool-result',
  };
}
async function resolveApprovedHostCall(
  run: Run,
  pending: PendingInteraction,
  platform: HostPlatform,
  dispatch: Dispatch
): Promise<ToolContent[number]> {
  const { event, decision } = pending;
  const refused = refusedHostOrigin(pending);
  if (
    refused !== undefined ||
    decision === 'deny' ||
    (await hostRunToolDecision(platform, run, event.toolId)) === 'deny'
  ) {
    return {
      output: {
        type: 'execution-denied',
        ...(refused === undefined ? {} : { reason: browserOriginDeniedReason(refused) }),
      },
      toolCallId: event.toolCallId,
      toolName: event.toolId,
      type: 'tool-result',
    };
  }
  const input = await resolveHostApprovalInput(run, event);
  const action: Action = {
    input: event.input,
    runId: run.id,
    toolCallId: event.toolCallId,
    toolId: event.toolId,
    toolIdentity: event.toolIdentity,
    type: 'effect.started',
  };
  run.permits.set(action.toolCallId, action);
  const resumeData =
    event.kind === 'approval'
      ? undefined
      : await validateHostInteractionResume(run, pending, pending.resumeData);
  const output = run.outputs.has(event.toolCallId)
    ? run.outputs.get(event.toolCallId)
    : await dispatch(action, input, resumeData);
  return modelResult(run, event.toolCallId, event.toolId, input, output);
}
/** Resolve already-issued calls at the existing step limit without another model request. */
async function finishApprovedHostResults(
  run: Run,
  platform: HostPlatform,
  dispatch: Dispatch
): Promise<ModelMessage[]> {
  const results: ToolContent = [];
  for (const approval of run.approvals.values()) {
    if (!run.checkpointedResults.has(approval.event.toolCallId)) {
      results.push(await resolveApprovedHostCall(run, approval, platform, dispatch));
    }
  }
  return results.length > 0 ? [{ content: results, role: 'tool' }] : [];
}
async function createHostApprovalResponses(
  run: Run,
  platform: HostPlatform,
  dispatch: Dispatch
): Promise<ToolContent> {
  const responses: ToolContent = [];
  for (const pending of run.approvals.values()) {
    const { event, decision } = pending;
    const refused = refusedHostOrigin(pending);
    if (!run.responses.has(event.interactionId)) {
      responses.push({
        approvalId: event.interactionId,
        approved: refused === undefined && (event.kind !== 'approval' || decision === 'approve'),
        ...(refused === undefined ? {} : { reason: browserOriginDeniedReason(refused) }),
        type: 'tool-approval-response',
      });
    }
    if (
      refused === undefined &&
      event.kind !== 'approval' &&
      !run.outputs.has(event.toolCallId) &&
      !run.checkpointedResults.has(event.toolCallId)
    ) {
      responses.push(await resolveApprovedHostCall(run, pending, platform, dispatch));
      continue;
    }
    if (run.outputs.has(event.toolCallId) && !run.checkpointedResults.has(event.toolCallId)) {
      const output = run.outputs.get(event.toolCallId);
      responses.push(
        await modelResult(
          run,
          event.toolCallId,
          event.toolId,
          await resolveHostApprovalInput(run, event),
          output ?? null
        )
      );
    }
  }
  return responses;
}
/** Core's seams for one run's continuation, bound to that run. */
export interface HostRunContinuationPorts {
  readonly commitMessages: (messages: readonly ModelMessage[]) => Promise<void>;
  readonly dispatch: Dispatch;
  readonly finish: (
    outcome: Extract<
      HostEvent,
      {
        type: 'run.finished';
      }
    >['outcome'],
    detail?: string
  ) => Promise<void>;
  readonly loop: (model: LanguageModel) => Promise<void>;
  readonly openRun: () => Promise<unknown>;
  readonly platform: HostPlatform;
}
/**
 * Continue a run once every decision it waits on is answered: commit the
 * approved calls' results, then finish (an approved plan, the step limit) or
 * loop again.
 */
export async function continueHostRun(run: Run, ports: HostRunContinuationPorts): Promise<void> {
  if (run.terminal) {
    return;
  }
  if (run.stopped) {
    await ports.finish('stopped');
    return;
  }
  if ([...run.approvals.values()].some((approval) => !hasHostInteractionResponse(approval))) {
    return;
  }
  try {
    const admission = await ensureHostRunAdmission(ports.platform, run);
    await ports.openRun();
    // The SDK collects approvals from one final tool message, preserving parallel calls.
    const responses = await createHostApprovalResponses(run, ports.platform, ports.dispatch);
    await ports.commitMessages(responses.length > 0 ? [{ content: responses, role: 'tool' }] : []);
    // An approved plan's run starts from this run's end (core-run-end.ts).
    if (approvedHostPlan(run)) {
      await ports.finish('completed');
      return;
    }
    if (run.steps >= admission.snapshot.maxSteps) {
      await ports.commitMessages(
        await finishApprovedHostResults(run, ports.platform, ports.dispatch)
      );
      await ports.finish('completed');
      return;
    }
    await ports.loop(admission.model);
  } catch (cause) {
    if (run.completion !== undefined) {
      throw cause;
    }
    const failed = hostContinuationFailure(run, cause);
    await ports.finish(failed.outcome, failed.detail);
  }
}
