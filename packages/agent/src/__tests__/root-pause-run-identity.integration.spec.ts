/**
 * WHAT RUN ID A ROOT PAUSE CARRIES (BST-1163 follow-up, 2026-09-15).
 *
 * The approval/suspend notice puts the pause's `runId` in its action echo, and
 * the history topology adapter once resolved the suspended message's durable
 * turn anchor with it (`getThreadRunTurnMessageId`). That lookup could never
 * hit: the pause carries Mastra's NATIVE run id, while
 * `brainstrike_assistant_thread_runs` ids are minted by the client
 * (`createThreadRunId`) and never reach `agent.stream`. The adapter now anchors
 * on the host leg the host stamps (`hostRunId`); these cases pin the producer
 * shape that ruling rests on, against the real Mastra loop.
 *
 * Live evidence this reproduces: fan-out verifier run 24 (thread-3b4b4bef), a
 * root `manageCanvas` approval carrying `2cc9a50d-…` while the thread's runs
 * were `run-ffcdbd6d-…` / `run-6172a925-…`.
 */
import { expect, it } from 'vitest';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import { hasToolResult, textParts, toolCallParts } from '../test-fixtures/scripted-agent-model';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

/** The durable host leg the desktop mints per request, before the model runs. */
const HOST_RUN_ID = 'run-host-leg-1';

function rootPauseRunIds(chunks: readonly StreamChunk[]): { runId: string; toolCallId: string }[] {
  return chunks.flatMap((chunk) =>
    chunk.type === 'tool-approval-required' && !chunk.delegation
      ? [{ runId: chunk.runId, toolCallId: chunk.toolCallId }]
      : []
  );
}

/** The native run ids observed as delegation parents — the root's own runs. */
function dispatchingNativeRunIds(chunks: readonly StreamChunk[]): string[] {
  return [
    ...new Set(
      [...JSON.stringify(chunks).matchAll(/"parentRuntimeRunId":"([^"]+)"/g)].map(
        (match) => match[1] as string
      )
    ),
  ];
}

it("a root pause on the INITIAL leg carries Mastra's native run id, never the host leg", async () => {
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    rootGate: true,
  });
  const { backing, runtime, runtimeData, entered, release, database } = fixture;
  const chunks: StreamChunk[] = [];
  try {
    const iterator = await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'root-gate', parts: [{ text: 'Report', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData: { ...runtimeData, memory: { ...runtimeData.memory, runId: HOST_RUN_ID } },
    });
    const consuming = (async () => {
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
    })();
    await entered.promise;
    release.resolve();
    await consuming;

    const [pause, ...extra] = rootPauseRunIds(chunks);
    expect(extra).toEqual([]);
    expect(pause?.toolCallId).toBe('root-write');
    // The host leg is never what the pause reports: Mastra mints its own run id
    // (`options?.runId || generateId()`) and no leg passes the host id in.
    expect(pause?.runId).not.toBe(HOST_RUN_ID);
    expect(pause?.runId).toBe(dispatchingNativeRunIds(chunks)[0]);
  } finally {
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
}, 60_000);

it('a root pause on a BACKGROUND WAKE-UP continuation carries a SECOND native run id', async () => {
  // One host leg holds several native runs: the idle loop continues the turn
  // with another `agent.stream([])` when returned work wakes the parent, and
  // Mastra mints a fresh run id for it. A per-leg native id column could not
  // model this; the host leg is the stable identity.
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    rootGate: true,
  });
  const { backing, runtime, runtimeData, entered, release, database, model } = fixture;
  const scripted = model.model.doStream;
  // The root ends its dispatching turn with text and only proposes its gated
  // write once the wakeup directive arrives — so the pause lands on the
  // continuation, not on the leg's first native run.
  model.model.doStream = async (options) => {
    const isRoot = options.tools?.some((tool) => tool.name === 'agent-explore') ?? false;
    if (!(isRoot && hasToolResult(options, 'agent-explore'))) {
      return scripted(options);
    }
    model.prompts.push(options);
    const lastUser = JSON.stringify(
      options.prompt.filter((message) => message.role === 'user').at(-1)
    );
    const parts = hasToolResult(options, 'brainstrike_writeWorkspaceFile')
      ? textParts('ROOT_DONE')
      : lastUser.includes('Background invocations of this turn')
        ? toolCallParts('brainstrike_writeWorkspaceFile', 'root-write-on-wake', {
            pattern: 'report',
          })
        : textParts('ROOT_ACK_WAITING');
    return {
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part);
          }
          controller.close();
        },
      }),
    };
  };
  const chunks: StreamChunk[] = [];
  try {
    const iterator = await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'wake-gate', parts: [{ text: 'Report', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData: { ...runtimeData, memory: { ...runtimeData.memory, runId: HOST_RUN_ID } },
    });
    const consuming = (async () => {
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
    })();
    await entered.promise;
    release.resolve();
    await consuming;

    const [pause] = rootPauseRunIds(chunks);
    expect(pause?.toolCallId).toBe('root-write-on-wake');
    expect(pause?.runId).not.toBe(HOST_RUN_ID);
    // And not the dispatching run either: the wake-up minted another one.
    expect(dispatchingNativeRunIds(chunks)).not.toContain(pause?.runId);
  } finally {
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
}, 60_000);
