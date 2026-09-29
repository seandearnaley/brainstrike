import { createLogger } from '@brainstrike/logging';
import type { BackgroundTask } from '@mastra/core/background-tasks';
import type {
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  Processor,
} from '@mastra/core/processors';
import { projectBackgroundOutcomeForModel } from '../background-result-projection';
import type { RuntimeData } from '../types';
import type { MastraAgentRuntime } from './agent-runtime';
import { completedBackgroundOutcome } from './background-result-delivery';
import { listLateBackgroundResults } from './background-results';

const logger = createLogger('LateBackgroundResults');
type Prompt = ProcessLLMRequestArgs['prompt'];
type ToolMessage = Extract<Prompt[number], { role: 'tool' }>;
type ToolPart = ToolMessage['content'][number];
type ToolResultOutput = Extract<ToolPart, { type: 'tool-result' }>['output'];

function outcomeOutput(task: BackgroundTask): ToolResultOutput {
  return projectBackgroundOutcomeForModel(completedBackgroundOutcome(task));
}

/**
 * LATE RESULTS AFTER A ROOT PAUSE (settled 2026-09-15, live-app verifier run
 * 7): a ROOT-level resume restores the message list snapshotted when the run
 * parked, in which every background child still running at that moment is a
 * dispatch acknowledgement — and Mastra replaces that restored list over the
 * `context` a resume is given, so no message can reach the resumed model.
 * The transient provider boundary can: this `processLLMRequest` processor
 * rewrites the acknowledgement tool results of the run's late-returned tasks
 * into their saved outcomes on every request of the resumed run, exactly as
 * `ToolProjectionRewriteProcessor` overlays stale reads. Memory is restored
 * separately once the leg settles (`restoreLateBackgroundResults`).
 */
export class LateBackgroundResultsProcessor implements Processor<'late-background-results'> {
  readonly id = 'late-background-results';
  readonly name = 'Background results returned after the run parked';
  private readonly outputs: ReadonlyMap<string, ToolResultOutput>;

  constructor(late: readonly BackgroundTask[]) {
    this.outputs = new Map(late.map((task) => [task.toolCallId, outcomeOutput(task)]));
  }

  processLLMRequest(args: ProcessLLMRequestArgs): ProcessLLMRequestResult | undefined {
    let rewritten = 0;
    const prompt = args.prompt.map((message) => {
      if (message.role !== 'tool') {
        return message;
      }
      const content = message.content.map((part): ToolPart => {
        if (part.type !== 'tool-result') {
          return part;
        }
        const output = this.outputs.get(part.toolCallId);
        if (!output) {
          return part;
        }
        rewritten += 1;
        const mastra = part.providerOptions?.['mastra'];
        return {
          ...part,
          output,
          ...(mastra
            ? {
                providerOptions: {
                  ...part.providerOptions,
                  mastra: { ...mastra, modelOutput: output },
                },
              }
            : {}),
        };
      });
      return content.some((part, index) => part !== message.content[index])
        ? { ...message, content }
        : message;
    });
    if (rewritten === 0) {
      return;
    }
    logger.info('Presented background results that returned after the run parked', {
      code: 'background_late_results_presented',
      rewritten,
    });
    return { prompt };
  }
}

export function createLateBackgroundResultsProcessor(
  late: readonly BackgroundTask[]
): Processor | undefined {
  return late.length === 0 ? undefined : new LateBackgroundResultsProcessor(late);
}

/**
 * The finished background results a ROOT-level resume cannot see: Mastra's
 * `approveToolCall`/`resumeStream` restore the message list snapshotted when
 * the run parked, so every child that returned after `AgentRun.suspendedAt`
 * is still a dispatch acknowledgement in the resumed run's transcript
 * (background-results.ts, LATE RESULTS AFTER A ROOT PAUSE).
 */
export async function readLateBackgroundResults(
  runtime: Pick<MastraAgentRuntime, 'agent' | 'backgroundTaskManager'>,
  runtimeData: RuntimeData | undefined,
  runId: string
): Promise<BackgroundTask[]> {
  const scope = runtimeData?.memory;
  if (!(runtime.backgroundTaskManager && scope)) {
    return [];
  }
  const { runs } = await runtime.agent.listSuspendedRuns({
    resourceId: scope.resourceId,
    threadId: scope.threadId,
  });
  const run = runs.find((candidate) => candidate.runId === runId);
  return listLateBackgroundResults({
    manager: runtime.backgroundTaskManager,
    runId,
    scope,
    suspendedAt: run?.suspendedAt,
  });
}

/**
 * The leg's native options plus the late results overlaid at the provider
 * boundary (a resume replaces any `context` with its restored snapshot).
 */
export function withLateBackgroundResults<Options extends { inputProcessors?: unknown[] }>(
  options: Options,
  late: readonly BackgroundTask[]
): Options {
  const processor = createLateBackgroundResultsProcessor(late);
  if (!processor) {
    return options;
  }
  logger.info('Overlaying background results that returned after the run parked', {
    code: 'background_late_results_overlaid',
    invocations: late.map((task) => `${task.toolCallId} (${task.toolName})`),
  });
  // First, so the stale-history filter and the limiter judge the real results.
  return { ...options, inputProcessors: [processor, ...(options.inputProcessors ?? [])] };
}

/** The late overlay sends the model no wakeup text; the row says so. */
export const LATE_OVERLAY_WAKEUP_DIRECTIVE =
  'Late background results overlaid at the provider boundary: dispatch acknowledgements replaced by saved outcomes. No model-facing wakeup text was sent.';

/**
 * Debug-pack evidence for the late overlay (swarm diagnostics, migration 139):
 * one `late-overlay` wakeup row naming every task whose saved outcome replaces
 * its acknowledgement on the resumed run. Nothing is recorded when nothing
 * returned late. Both overlay call sites (approval and typed resume) share it.
 */
export async function recordLateOverlayWakeup(
  runtime: Pick<MastraAgentRuntime, 'conversationBinding'>,
  late: readonly BackgroundTask[]
): Promise<void> {
  if (late.length === 0) {
    return;
  }
  await runtime.conversationBinding?.recordWakeup?.({
    directive: LATE_OVERLAY_WAKEUP_DIRECTIVE,
    invocations: late.map((task) => ({
      outcome: 'late' as const,
      taskId: task.id,
      toolCallId: task.toolCallId,
      toolName: task.toolName,
    })),
    kind: 'late-overlay',
  });
}
