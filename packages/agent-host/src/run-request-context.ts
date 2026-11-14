/**
 * A run's request context over its committed branch: healed interrupted
 * history, tool-output rewrites and the compaction overlay, in the legacy
 * order, and the compactions a context overflow or the trigger commits.
 */
import { resolveProviderError } from '@brainstrike/agent/provider-runtime';
import type { ModelMessage } from 'ai';
import {
  type HostCompactedContext,
  overflowCompaction,
  prepareCompactedContext,
  summarizeHostContext,
} from './context-compaction.ts';
import type { HostRequestExtras } from './context-size.ts';
import type { HostRunExecutionPorts } from './core-run-execution.ts';
import type { HostRunState as Run } from './core-state.ts';
import { healInterruptedRunHistory } from './interrupted-history.ts';
import type { HostRunAdmission } from './ports.ts';
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
  const event = await overflowCompaction({
    chain: [...ancestors, run],
    compactions: ports.compactions.read(run.threadId),
    compactionTokenCap: admission?.compactionTokenCap,
    inputTokenLimit: admission?.inputTokenLimit,
    messages,
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
 * trigger), in the legacy order.
 */
export async function prepareRunContext(
  ports: Ports,
  run: Run,
  ancestors: readonly Run[],
  admission: HostRunAdmission
): Promise<HostCompactedContext> {
  const messages = hostRunContext(ports.runs, run);
  const healed = healInterruptedRunHistory(messages, ancestors, run.threadId);
  const rewritten = await rewriteRunContext(ports, run, ancestors, healed);
  return await prepareCompactedContext({
    chain: [...ancestors, run],
    classify: (cause) => resolveProviderError(cause, admission.configuration).failure,
    commit: (event) => commitContextEvent(ports, run, event),
    compactions: ports.compactions.read(run.threadId),
    compactionTokenCap: admission.compactionTokenCap,
    inputTokenLimit: admission.inputTokenLimit,
    messages: rewritten,
    readRequestExtras: () => readHostRequestExtras(ports, run, admission, rewritten),
    // Read after `rewriteRunContext`, which may have committed this request's own.
    rewrites: ports.rewrites.read(run.threadId),
    signal: run.controller.signal,
    summarize: (transcript) =>
      summarizeHostContext(admission.model, run, transcript, run.controller.signal),
    unrewritten: healed,
  });
}
