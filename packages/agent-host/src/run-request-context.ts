/**
 * A run's request context over its committed branch: healed interrupted
 * history, tool-output rewrites and the compaction overlay, in the legacy
 * order, and the compactions a context overflow or the trigger commits.
 */
import { resolveProviderError } from '@brainstrike/agent/provider-runtime';
import type { ModelMessage } from 'ai';
import {
  overflowCompaction,
  prepareCompactedContext,
  summarizeHostContext,
} from './context-compaction.ts';
import type { HostRequestExtras } from './context-size.ts';
import type { HostRunExecutionPorts } from './core-run-execution.ts';
import type { HostRunState as Run } from './core-state.ts';
import { healInterruptedRunHistory } from './interrupted-history.ts';
import type { HostPreparedStep, HostRunAdmission, HostRunOwner } from './ports.ts';
import { applyProjectionRewrites, prepareProjectionRewrites } from './projection-rewrites.ts';
import type { HostEvent } from './protocol.ts';
import { combineHostSystemContext, hostStepActiveTools } from './run-admission.ts';
import { hostRunAncestors, hostRunContext } from './run-branch.ts';

type Ports = Pick<
  HostRunExecutionPorts,
  'append' | 'compactions' | 'foldRows' | 'platform' | 'rewrites' | 'runs'
>;

async function commitContextEvent(ports: Ports, run: Run, event: HostEvent): Promise<void> {
  await ports.append(run.threadId, [event], 'full', (rows) => ports.foldRows(rows));
}

/** Committed tool-output rewrites, plus the policy's new ones, on this step's messages. */
export function rewriteRunContext(
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
  const event = await overflowCompaction({
    chain: [...ancestors, run],
    compactions: ports.compactions.read(run.threadId),
    compactionTokenCap: admission?.compactionTokenCap,
    inputTokenLimit: admission?.inputTokenLimit,
    messages,
    readRequestExtras: admission
      ? () => readHostRequestExtras(ports, run, admission, messages)
      : undefined,
  });
  if (!event) {
    return false;
  }
  await commitContextEvent(ports, run, event);
  return true;
}

/**
 * The run's first request context: heal interrupted history, apply committed
 * tool-output rewrites (and the policy's new ones), then the compaction
 * overlay (and a new compaction past the trigger), in the legacy order. With
 * Memory, the trigger measures the request Memory builds (ADR-0013), and that
 * request is the first step's.
 */
export async function prepareRunContext(
  ports: Ports,
  run: Run,
  ancestors: readonly Run[],
  admission: HostRunAdmission,
  messages: readonly ModelMessage[],
  owner: HostRunOwner | undefined
): Promise<{
  readonly messages: ModelMessage[];
  readonly note?: string;
  readonly step?: HostPreparedStep;
}> {
  const healed = healInterruptedRunHistory(messages, ancestors, run.threadId);
  const rewritten = await rewriteRunContext(ports, run, ancestors, healed);
  const prepareStep = owner?.prepareHostStep?.bind(owner);
  return await prepareCompactedContext({
    chain: [...ancestors, run],
    classify: (cause) => resolveProviderError(cause, admission.configuration).failure,
    commit: (event) => commitContextEvent(ports, run, event),
    compactions: ports.compactions.read(run.threadId),
    compactionTokenCap: admission.compactionTokenCap,
    inputTokenLimit: admission.inputTokenLimit,
    ...(prepareStep
      ? {
          prepareStep: (overlaid: readonly ModelMessage[]) =>
            prepareStep({ messages: overlaid, stepNumber: run.steps }),
        }
      : {}),
    messages: rewritten,
    readRequestExtras: () => readHostRequestExtras(ports, run, admission, rewritten),
    signal: run.controller.signal,
    summarize: (transcript) =>
      summarizeHostContext(admission.model, run, transcript, run.controller.signal),
  });
}
