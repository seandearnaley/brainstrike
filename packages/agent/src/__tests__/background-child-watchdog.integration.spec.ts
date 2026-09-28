/**
 * A wedged BACKGROUND child fails as its OWN task (docs/agents/assistant-runtime.md,
 * "Stream inactivity watchdog"; docs/agents/assistant-subagents.md, "Background
 * child deadlines").
 *
 * Real runtime, real PGlite, real Mastra background manager; only the model
 * transport is scripted. A child whose provider stream stops mid-answer is
 * ended by its own watchdog at its inter-output window: its task fails naming
 * the stall, its child view gets one `run.failed`, its sibling completes, and
 * the parent — never stalled itself — is woken with the failure and finishes.
 */
import { afterEach, expect, it } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import {
  createStreamIteratorFromRuntime,
  createToolApprovalIteratorFromRuntime,
} from '../mastra/attempt-legs';
import { listSuspendedMastraRuns } from '../mastra/suspended-run-discovery';
import { hasToolResult } from '../test-fixtures/scripted-agent-model';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

const INTER_OUTPUT_MS = 1000;
const STALL_TEXT = `Subagent stalled: no output for ${INTER_OUTPUT_MS}ms while streaming its answer (its inter-output window), so the host ended it.`;

const WINDOW_ENV = ['BRAINSTRIKE_STREAM_INACTIVITY_MS', 'BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'];
const previousWindows = new Map(WINDOW_ENV.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, previous] of previousWindows) {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = previous;
    }
  }
});

/** A provider stream that starts its answer, then goes silent until it is aborted. */
function wedgedAnswer(signal: AbortSignal | undefined) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ id: 'answer', type: 'text-start' });
        controller.enqueue({ delta: 'PARTIAL_WEDGED', id: 'answer', type: 'text-delta' });
        signal?.addEventListener('abort', () => controller.error(signal.reason), {
          once: true,
        });
      },
    }),
  };
}

it.each([
  { label: 'one wedged child among producing siblings', wedged: [1] },
  { label: 'every child wedged', wedged: [1, 2] },
])('$label: each wedged child fails alone and the parent finishes', async ({ wedged }) => {
  process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = String(INTER_OUTPUT_MS);
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    rootReadsLedger: true,
    siblings: 2,
  });
  const { backing, database, model, release, runtime, runtimeData, wakeups } = fixture;
  release.resolve();
  const wedgedSignals: AbortSignal[] = [];
  const scripted = model.model.doStream;
  model.model.doStream = async (options) => {
    const sibling = JSON.stringify(options.prompt).match(/Read background evidence (\d+)/)?.[1];
    const answering = options.prompt.some((message) => message.role === 'tool');
    const isRoot = options.tools?.some((tool) => tool.name === 'agent-explore') === true;
    if (isRoot || !answering || !wedged.includes(Number(sibling))) {
      return scripted(options);
    }
    // The wedged child's provider starts its answer, then goes silent for good.
    model.prompts.push(options);
    const signal = options.abortSignal;
    if (signal) {
      wedgedSignals.push(signal);
    }
    return wedgedAnswer(signal);
  };
  try {
    const iterator = await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        { id: 'fanout', parts: [{ text: 'Read both evidence files', type: 'text' }], role: 'user' },
      ],
      runtime,
      runtimeData,
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    // The parent was never stalled, and it finished its turn.
    const rootEvents = chunks.flatMap((chunk) =>
      chunk.type === 'run-event' ? [chunk.event.kind] : []
    );
    expect(rootEvents).not.toContain('run.stalled');
    expect(rootEvents).not.toContain('run.failed');
    expect(
      chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.value)
        .join('')
    ).toContain('PARENT_FINAL_OUTCOME');

    // Each wedged child failed as its own task, naming its stall; the rest returned.
    const tasks = (await runtime.backgroundTaskManager?.listTasks({}))?.tasks ?? [];
    expect(
      tasks
        .map((task) => ({
          error: task.error?.message,
          status: task.status,
          toolCallId: task.toolCallId,
        }))
        .sort((left, right) => left.toolCallId.localeCompare(right.toolCallId))
    ).toEqual(
      [1, 2].map((sibling) => ({
        error: wedged.includes(sibling) ? STALL_TEXT : undefined,
        status: wedged.includes(sibling) ? 'failed' : 'completed',
        toolCallId: `background-child-${sibling}`,
      }))
    );
    expect(wedgedSignals).toHaveLength(wedged.length);
    expect(wedgedSignals.every((signal) => signal.aborted)).toBe(true);

    // One visible failure per wedged child, in its own view.
    for (const sibling of [1, 2]) {
      const terminals = chunks.flatMap((chunk) =>
        chunk.type === 'delegated-conversation-chunk' &&
        chunk.identity.parentToolCallId === `background-child-${sibling}` &&
        chunk.chunk.type === 'run-event' &&
        (chunk.chunk.event.kind === 'run.failed' || chunk.chunk.event.kind === 'run.finished')
          ? [
              {
                detail: chunk.chunk.event.detail,
                kind: chunk.chunk.event.kind,
                metadata: chunk.chunk.event.metadata,
              },
            ]
          : []
      );
      expect(terminals).toEqual(
        wedged.includes(sibling)
          ? [
              {
                detail: STALL_TEXT,
                kind: 'run.failed',
                // The stall's full breadcrumb rides the durable child terminal.
                metadata: expect.objectContaining({
                  code: 'background_child_stalled',
                  inactivityMs: INTER_OUTPUT_MS,
                  lastPartType: 'text-delta',
                  phase: 'streaming',
                }),
              },
            ]
          : [expect.objectContaining({ kind: 'run.finished' })]
      );
    }

    // The parent was woken with each failure like any other failed task.
    const directives = wakeups.map((wakeup) => wakeup.directive).join('\n');
    for (const sibling of wedged) {
      expect(directives).toContain(
        `background-child-${sibling} (agent-explore, Explorer): failed — ${STALL_TEXT}`
      );
    }
  } finally {
    await runtime.dispose();
    await database.close();
  }
});

// A resume leg runs the resumed child through the HOST's own executor, which
// addresses the child's stall by its task's dispatch — `{runId, toolCallId}` —
// while `prepare` registers the execution under the native agent tool's own
// `{runId, toolCallId}`. They must be the same key, or every resumed child's
// stall ends nothing (`background_child_stall_undeliverable`).
it("a resumed child's stall ends that resumed execution as its own failed task", async () => {
  process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = String(INTER_OUTPUT_MS);
  // Bounds the leg if the stall were undeliverable, so this fails instead of hanging.
  process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '3000';
  const fixture = await createBackgroundFixture(true);
  const {
    backing,
    database,
    discoveryOptions,
    effect,
    model,
    release,
    runtime,
    runtimeData,
    scope,
  } = fixture;
  release.resolve();
  const scripted = model.model.doStream;
  const wedgedSignals: AbortSignal[] = [];
  model.model.doStream = async (options) => {
    const isRoot = options.tools?.some((tool) => tool.name === 'agent-explore') === true;
    // After its approved read returns, the resumed child starts answering and wedges.
    if (!isRoot && hasToolResult(options, 'brainstrike_grepSearch')) {
      model.prompts.push(options);
      if (options.abortSignal) {
        wedgedSignals.push(options.abortSignal);
      }
      return wedgedAnswer(options.abortSignal);
    }
    return scripted(options);
  };
  let resumedRuntime: Awaited<ReturnType<typeof createMastraAgentRuntime>> | undefined;
  try {
    const initial = await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        { id: 'gated', parts: [{ text: 'Read gated evidence', type: 'text' }], role: 'user' },
      ],
      runtime,
      runtimeData,
    });
    for await (const _chunk of initial) {
      // The child parks on its gated read.
    }
    const approval = (await listSuspendedMastraRuns(scope, discoveryOptions)).approvals[0];
    if (!approval) {
      throw new Error('Missing the parked child approval');
    }
    resumedRuntime = await createMastraAgentRuntime(discoveryOptions);
    const resumed = await createToolApprovalIteratorFromRuntime({
      action: {
        action: 'approve',
        runId: approval.runId,
        toolCallId: approval.toolCallId,
        ...(approval.delegation ? { delegation: approval.delegation } : {}),
      },
      memory: backing.memory,
      runtime: resumedRuntime,
      runtimeData,
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of resumed) {
      chunks.push(chunk);
    }
    expect(effect).toHaveBeenCalledTimes(1);
    // The resumed execution was ended by its own stall, not by the parent.
    expect(wedgedSignals).toHaveLength(1);
    expect(wedgedSignals[0]?.aborted).toBe(true);
    const tasks = (await resumedRuntime.backgroundTaskManager?.listTasks({}))?.tasks ?? [];
    expect(tasks.map((task) => ({ error: task.error?.message, status: task.status }))).toEqual([
      { error: STALL_TEXT, status: 'failed' },
    ]);
    const rootEvents = chunks.flatMap((chunk) =>
      chunk.type === 'run-event' ? [chunk.event.kind] : []
    );
    expect(rootEvents).not.toContain('run.stalled');
    expect(rootEvents).not.toContain('run.failed');
    expect(
      chunks.flatMap((chunk) =>
        chunk.type === 'delegated-conversation-chunk' &&
        chunk.chunk.type === 'run-event' &&
        chunk.chunk.event.kind === 'run.failed'
          ? [chunk.chunk.event.detail]
          : []
      )
    ).toEqual([STALL_TEXT]);
  } finally {
    await resumedRuntime?.dispose();
    await runtime.dispose();
    await database.close();
  }
});
