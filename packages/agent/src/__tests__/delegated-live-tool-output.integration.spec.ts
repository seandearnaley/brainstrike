import { expect, it } from 'vitest';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

const READ_ASK_POLICY = {
  policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
  riskByTool: { 'brainstrike.grepSearch': 'read' },
  yolo: false,
} as const;

it('projects the first live-approved Worker custom output onto its paused native child', async () => {
  // Sibling 2 keeps the root leg open while sibling 1 asks. The live decision
  // resumes sibling 1 inside that same leg; its first tool output is writer.custom
  // without a runId, before Mastra emits a new child tool-call part.
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, true, 1, {
    customToolOutput: 'shell',
    heldSibling: 2,
    permissionPolicy: {
      ...READ_ASK_POLICY,
      perToolOverrides: { 'brainstrike.readWorkspaceFile': 'allow' },
    },
    siblings: 2,
  });
  const { backing, database, hold, release, runtime, runtimeData } = fixture;
  release.resolve();
  const chunks: StreamChunk[] = [];
  let decision: Promise<void> | undefined;
  let approvedPath:
    | readonly {
        childRuntimeRunId: string;
        parentRuntimeRunId: string;
        parentToolCallId: string;
        personaId: string;
      }[]
    | undefined;
  try {
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [{ id: 'live-output', parts: [{ text: 'Survey', type: 'text' }], role: 'user' }],
      runtime,
      runtimeData,
    })) {
      chunks.push(chunk);
      if (
        chunk.type === 'tool-approval-required' &&
        chunk.delegation?.toolCallId === 'background-read-1' &&
        !decision
      ) {
        approvedPath = chunk.delegation.path;
        decision = fixture.decide({
          action: {
            action: 'approve',
            delegation: chunk.delegation,
            runId: chunk.runId,
            toolCallId: chunk.toolCallId,
          },
        });
        void decision.then(
          () => hold.resolve(),
          () => hold.resolve()
        );
      }
    }
    await expect(decision).resolves.toBeUndefined();
    const leaf = approvedPath?.at(-1);
    expect(leaf).toBeDefined();
    const liveOutput = chunks.filter(
      (chunk) =>
        chunk.type === 'delegated-conversation-chunk' &&
        chunk.chunk.type === 'shell-output' &&
        chunk.chunk.toolCallId === 'background-read-1'
    );
    expect(liveOutput).toHaveLength(1);
    expect(liveOutput[0]).toMatchObject({
      chunk: { chunk: 'synthetic shell output', stream: 'stdout' },
      identity: leaf,
      messageId: expect.any(String),
    });
    expect(
      chunks.filter((chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed')
    ).toEqual([]);
    expect(
      chunks.filter(
        (chunk) =>
          chunk.type === 'delegated-conversation-chunk' &&
          chunk.chunk.type === 'run-event' &&
          chunk.chunk.event.kind === 'tool.failed'
      )
    ).toEqual([]);
    expect(
      chunks.filter(
        (chunk) =>
          chunk.type === 'delegated-conversation-chunk' &&
          chunk.chunk.type === 'run-event' &&
          chunk.chunk.event.kind === 'tool.completed' &&
          chunk.identity.parentToolCallId === leaf?.parentToolCallId
      )
    ).toHaveLength(1);
    expect(JSON.stringify(chunks)).toContain('PARENT_FINAL_OUTCOME');
  } finally {
    hold.resolve();
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
});
