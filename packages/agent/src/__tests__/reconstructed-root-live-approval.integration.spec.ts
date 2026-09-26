import { expect, it } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import {
  createStreamIteratorFromRuntime,
  createToolApprovalIteratorFromRuntime,
} from '../mastra/attempt-legs';
import { listSuspendedMastraRuns } from '../mastra/suspended-run-discovery';
import { hasToolResult } from '../test-fixtures/scripted-agent-model';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

const READ_ASK_POLICY = {
  policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
  riskByTool: { 'brainstrike.grepSearch': 'read' },
  yolo: false,
} as const;

it('resumes three parked Explorers through a fresh root approval leg and live read grant', async () => {
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 2, {
    concurrentSiblings: true,
    permissionPolicy: READ_ASK_POLICY,
    rootGate: true,
    siblings: 3,
    slowRootTurn: true,
  });
  const { backing, database, discoveryOptions, model, release, runtime, runtimeData, scope } =
    fixture;
  const rootModelRelease = Promise.withResolvers<void>();
  const rootModelEntered = Promise.withResolvers<void>();
  let resumed: Awaited<ReturnType<typeof createMastraAgentRuntime>> | undefined;
  let consuming: Promise<void> | undefined;
  release.resolve();
  try {
    const initial: StreamChunk[] = [];
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        { id: 'three-explorers', parts: [{ text: 'Survey', type: 'text' }], role: 'user' },
      ],
      runtime,
      runtimeData,
    })) {
      initial.push(chunk);
    }
    const pendingChildren = initial.filter(
      (chunk) => chunk.type === 'tool-approval-required' && chunk.delegation !== undefined
    );
    expect(pendingChildren).toHaveLength(3);
    const rootApproval = (await listSuspendedMastraRuns(scope, discoveryOptions)).approvals.find(
      (entry) => entry.toolCallId === 'root-write' && !entry.delegation
    );
    expect(rootApproval).toBeDefined();
    if (!rootApproval) {
      throw new Error('The root write did not park after its three children.');
    }
    await runtime.dispose();

    // The root approval is a NEW host runtime while the three child tasks are
    // still parked. Keep its post-approval model step open to deliver the
    // child's read grant into this ordinary root leg, as in the debug pack.
    const originalStream = model.model.doStream;
    model.model.doStream = async (options) => {
      const output = await originalStream(options);
      if (
        !(
          options.tools?.some((tool) => tool.name === 'agent-explore') &&
          hasToolResult(options, 'brainstrike_writeWorkspaceFile')
        )
      ) {
        return output;
      }
      return {
        ...output,
        stream: new ReadableStream({
          async start(controller) {
            rootModelEntered.resolve();
            await rootModelRelease.promise;
            for await (const part of output.stream) {
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
      };
    };
    resumed = await createMastraAgentRuntime(discoveryOptions);
    const chunks: StreamChunk[] = [];
    const iterator = await createToolApprovalIteratorFromRuntime({
      action: { action: 'approve', runId: rootApproval.runId, toolCallId: rootApproval.toolCallId },
      memory: backing.memory,
      runtime: resumed,
      runtimeData,
    });
    consuming = (async () => {
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
    })();
    consuming.catch(() => {});
    await rootModelEntered.promise;
    const first = pendingChildren.find(
      (chunk) =>
        chunk.type === 'tool-approval-required' &&
        chunk.delegation?.toolCallId === 'background-read-1'
    );
    if (first?.type !== 'tool-approval-required' || !first.delegation) {
      throw new Error('The first Explorer has no observed approval address.');
    }
    await fixture.decide({
      action: {
        action: 'approve',
        delegation: first.delegation,
        runId: first.runId,
        toolCallId: first.toolCallId,
      },
      permissionPolicy: { ...READ_ASK_POLICY, sessionGrants: ['read'] },
    });
    rootModelRelease.resolve();
    await consuming;
    const nativeTasks = await resumed.backgroundTaskManager?.listTasks({});
    expect(nativeTasks?.tasks.map((task) => ({ error: task.error, status: task.status }))).toEqual([
      { error: undefined, status: 'completed' },
      { error: undefined, status: 'completed' },
      { error: undefined, status: 'completed' },
    ]);
    const failed = chunks.filter(
      (chunk) =>
        chunk.type === 'run-event' &&
        (chunk.event.kind === 'subagent.failed' || chunk.event.kind === 'tool.failed')
    );
    expect(failed).toEqual([]);
    expect(fixture.effect).toHaveBeenCalledTimes(6);
    expect(
      (await resumed.backgroundTaskManager?.listTasks({ status: 'suspended' }))?.tasks
    ).toEqual([]);
  } finally {
    rootModelRelease.resolve();
    release.resolve();
    await Promise.allSettled([consuming]);
    await resumed?.dispose();
    await runtime.dispose();
    await database.close();
  }
});
