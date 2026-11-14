/**
 * A run's request context over its committed branch: healed interrupted
 * history, tool-output rewrites and the compaction overlay, in the legacy
 * order, and the compactions a context overflow or the trigger commits; and
 * the one builder of a step's request, which a compaction's summary call
 * shares (BST-2532).
 */
import { resolveProviderError } from '@brainstrike/agent/provider-runtime';
import type { LanguageModel, ModelMessage } from 'ai';
import { hostCompactionLedger } from './compaction-ledger.ts';
import { summarizeOnRunRequest } from './compaction-summary-call.ts';
import {
  type HostCompactedContext,
  type HostCompactionLedgerReader,
  type HostContextSummarizer,
  type HostRequestedBranch,
  overflowCompaction,
  prepareCompactedContext,
  requestedCompaction,
} from './context-compaction.ts';
import { hostContextNotes } from './context-notes.ts';
import type { HostRequestExtras } from './context-size.ts';
import type { HostRunExecutionPorts } from './core-run-execution.ts';
import type { HostRunState as Run } from './core-state.ts';
import { healInterruptedRunHistory } from './interrupted-history.ts';
import type { HostPreparedModelRequest, HostRunAdmission } from './ports.ts';
import {
  applyProjectionRewrites,
  committedRewrites,
  prepareProjectionRewrites,
} from './projection-rewrites.ts';
import type { HostEvent } from './protocol.ts';
import {
  combineHostSystemContext,
  createAdmittedHostSdkTools,
  hostRunTools,
  hostStepActiveTools,
  prepareHostProviderStep,
} from './run-admission.ts';
import { hostRunAncestors, hostRunContext } from './run-branch.ts';
import { hostProviderHistory } from './run-history.ts';
import { hostSideRequestBoundary } from './run-provider-request.ts';

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;

type Ports = Pick<
  HostRunExecutionPorts,
  | 'append'
  | 'compactions'
  | 'foldRows'
  | 'platform'
  | 'readCommittedRows'
  | 'records'
  | 'rewrites'
  | 'runs'
>;

/** Core's seams a request's context reads and commits through. */
export type HostRequestContextPorts = Ports;

/** Encloses the step's model in the run's provider request boundary, when the run has one. */
type HostRequestBoundary = ((model: LanguageModel) => LanguageModel) | undefined;

/** A step's request beside its tools; without a provider port the step keeps the run's model. */
export type HostStepPrepared = Omit<HostPreparedModelRequest, 'model'> & {
  readonly model?: LanguageModel;
};

/**
 * A step's request beside its tools, as the step sends it: the provider's
 * preparation of `messages`, the run's instructions with the per-step notes
 * and a hook's context, the model inside the run's request boundary, and the
 * tools the step offers. A run's steps and its compaction's summary call are
 * both built here, so the summary call sends the run's own prefix.
 */
export async function hostStepRequest(
  ports: Ports,
  run: Run,
  admission: HostRunAdmission,
  messages: ModelMessage[],
  boundary: HostRequestBoundary
): Promise<HostStepPrepared> {
  // Per-step notes from committed thread state (the legacy task-list note).
  const notes = hostContextNotes(hostRunTools(run), ports.records.stateView(run.threadId));
  const activeTools = await hostStepActiveTools(run, ports.platform);
  // An approved call that entered a worktree resumes with a model step:
  // it may answer, never act, in the run's old workspace (ADR-0028).
  const gated = run.enteredWorktree
    ? { activeTools: [], toolChoice: 'none' as const }
    : activeTools
      ? { activeTools }
      : {};
  if (!admission.provider) {
    return {
      messages,
      // A UserPromptSubmit hook's context joins the run's instructions.
      ...combineHostSystemContext(notes, run.promptContext),
      ...gated,
    };
  }
  const provider = await admission.provider.prepare({
    configuration: admission.configuration,
    messages,
    modelId: run.modelId,
    signal: run.controller.signal,
    // BST-1932: a child reserves its last step for a tool-free summary.
    stepNumber: run.steps,
  });
  return { ...prepareHostProviderStep(provider, notes, boundary, run.promptContext), ...gated };
}

/**
 * BST-2532: the compaction's summary, asked on the run's next request. The
 * request is built as the run's step builds it, over the branch's committed
 * history, and goes through the same provider request boundary, so it opens
 * with the prefix the run's last request cached. `focus` is what a person who
 * asked for the compaction wants it to keep (BST-2536).
 */
function summarizeRunContext(
  ports: Ports,
  run: Run,
  admission: HostRunAdmission,
  model: LanguageModel,
  focus?: string
): HostContextSummarizer {
  return async (context) => {
    const rows = ports.readCommittedRows(run);
    const boundary = admission.providerRequest
      ? hostSideRequestBoundary(
          admission.providerRequest,
          hostProviderHistory(rows, { runId: run.id, threadId: run.threadId }),
          committedRewrites(rows)
        )
      : undefined;
    const step = await hostStepRequest(ports, run, admission, [...context], boundary);
    return await summarizeOnRunRequest(
      {
        ...step,
        model: step.model ?? boundary?.(model) ?? model,
        tools: createAdmittedHostSdkTools(run, async () => {
          throw new Error('A compaction summary call never runs a tool');
        }),
      },
      run,
      run.controller.signal,
      focus
    );
  };
}

async function commitContextEvent(ports: Ports, run: Run, event: HostEvent): Promise<void> {
  await ports.append(run.threadId, [event], 'full', (rows) => ports.foldRows(rows));
}

/**
 * BST-2527: what the log holds for everything a compaction of the run's branch
 * covers, read from its committed rows when the compaction commits: the
 * person's requests, the files the covered calls edited and the tools the
 * run's own discovery reads as loaded there.
 */
function readRunLedger(
  ports: Ports,
  run: Run,
  chain: readonly Run[],
  admission: HostRunAdmission | undefined
): HostCompactionLedgerReader {
  return (covered) =>
    hostCompactionLedger(
      { chain, discovery: admission?.discovery, rows: ports.readCommittedRows(run) },
      covered
    );
}

/** Committed tool-output rewrites, plus the policy's new ones, on this step's messages. */
function rewriteRunContext(
  ports: Ports,
  run: Run,
  ancestors: readonly Run[],
  messages: readonly ModelMessage[]
): Promise<ModelMessage[]> {
  return prepareProjectionRewrites({
    commit: (event) => commitContextEvent(ports, run, event),
    existing: ports.rewrites.read(run.threadId),
    messages,
    outputs: new Map([...ancestors, run].flatMap((turn) => [...turn.outputs])),
    runId: run.id,
    select: ports.platform.selectProjectionRewrites?.bind(ports.platform),
  });
}

/**
 * What the run's request carries beside its messages, read only for a size no
 * provider reported: its instructions as its provider prepares them, with a
 * hook's context, and the definitions of the tools its step offers.
 */
async function readHostRequestExtras(
  ports: Ports,
  run: Run,
  admission: HostRunAdmission,
  messages: readonly ModelMessage[]
): Promise<HostRequestExtras> {
  const provider = await admission.provider?.prepare({
    configuration: admission.configuration,
    messages,
    modelId: run.modelId,
    signal: run.controller.signal,
    stepNumber: run.steps,
  });
  const { system } = combineHostSystemContext(provider?.system, run.promptContext);
  const active = await hostStepActiveTools(run, ports.platform);
  return {
    ...(system === undefined ? {} : { instructions: system }),
    tools: active
      ? Object.fromEntries(
          active.flatMap((id) => {
            const tool = admission.tools[id];
            return tool ? [[id, tool] as const] : [];
          })
        )
      : admission.tools,
  };
}

/**
 * After a context overflow: commit the legacy deterministic compaction of the
 * run's branch, as its next attempt would see it. False when nothing was
 * droppable, so no recovery is claimed.
 */
export async function recoverHostContextOverflow(ports: Ports, run: Run): Promise<boolean> {
  const ancestors = hostRunAncestors(ports.runs, run);
  const healed = healInterruptedRunHistory(
    hostRunContext(ports.runs, run),
    ancestors,
    run.threadId
  );
  const messages = applyProjectionRewrites(healed, ports.rewrites.read(run.threadId));
  const admission = run.admission;
  const chain = [...ancestors, run];
  const event = await overflowCompaction({
    chain,
    compactions: ports.compactions.read(run.threadId),
    compactionTokenCap: admission?.compactionTokenCap,
    inputTokenLimit: admission?.inputTokenLimit,
    messages,
    readLedger: readRunLedger(ports, run, chain, admission),
    readRequestExtras: admission
      ? () => readHostRequestExtras(ports, run, admission, messages)
      : undefined,
    rewrites: ports.rewrites.read(run.threadId),
    unrewritten: healed,
  });
  if (!event) {
    return false;
  }
  await commitContextEvent(ports, run, event);
  return true;
}

/**
 * A step's request context, from the run's committed branch (BST-2531): heal
 * interrupted history, apply committed tool-output rewrites (and the policy's
 * new ones), then the compaction overlay (and a new compaction past the
 * trigger, summarized on the run's next request), in the legacy order.
 * `model` is the run's own, which a step without a provider port sends to.
 */
export async function prepareRunContext(
  ports: Ports,
  run: Run,
  ancestors: readonly Run[],
  admission: HostRunAdmission,
  model: LanguageModel
): Promise<HostCompactedContext> {
  const messages = hostRunContext(ports.runs, run);
  const healed = healInterruptedRunHistory(messages, ancestors, run.threadId);
  const rewritten = await rewriteRunContext(ports, run, ancestors, healed);
  const chain = [...ancestors, run];
  return await prepareCompactedContext({
    chain,
    classify: (cause) => resolveProviderError(cause, admission.configuration).failure,
    commit: (event) => commitContextEvent(ports, run, event),
    compactions: ports.compactions.read(run.threadId),
    compactionTokenCap: admission.compactionTokenCap,
    inputTokenLimit: admission.inputTokenLimit,
    messages: rewritten,
    readLedger: readRunLedger(ports, run, chain, admission),
    readRequestExtras: () => readHostRequestExtras(ports, run, admission, rewritten),
    // Read after `rewriteRunContext`, which may have committed this request's own.
    rewrites: ports.rewrites.read(run.threadId),
    signal: run.controller.signal,
    summarize: summarizeRunContext(ports, run, admission, model),
    unrewritten: healed,
  });
}

/**
 * BST-2536: the branch that ends with `tip` as the thread's next request
 * reads it, before its rewrites' policy runs: healed, with the committed
 * tool-output rewrites, and the thread's compactions.
 */
export function requestedRunBranch(ports: Ports, tip: Run): HostRequestedBranch {
  const chain = [...hostRunAncestors(ports.runs, tip), tip];
  const healed = healInterruptedRunHistory(hostRunContext(ports.runs, tip), chain, tip.threadId);
  return {
    chain,
    compactions: ports.compactions.read(tip.threadId),
    messages: applyProjectionRewrites(healed, ports.rewrites.read(tip.threadId)),
  };
}

/**
 * BST-2536: a compaction a person asked for between runs, of the branch that
 * ends with `tip`. Its summary is asked on the request the thread's next run
 * sends first: `next` holds that request's admission (the thread's selected
 * model and settings) under the tip's identity, so the request reads the
 * tip's branch, its tools and its cached prefix. The event belongs to the tip.
 */
export async function compactRequestedBranch(
  ports: Ports,
  tip: Run,
  next: Run,
  admission: HostRunAdmission,
  focus: string | undefined
): Promise<Compacted> {
  const branch = requestedRunBranch(ports, tip);
  return await requestedCompaction({
    ...branch,
    classify: (cause) => resolveProviderError(cause, admission.configuration).failure,
    focus,
    readLedger: readRunLedger(ports, tip, branch.chain, admission),
    signal: next.controller.signal,
    summarize: summarizeRunContext(ports, next, admission, admission.model, focus),
  });
}
