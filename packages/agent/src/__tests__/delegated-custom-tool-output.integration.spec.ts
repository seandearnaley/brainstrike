import { expect, it } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import {
  createStreamIteratorFromRuntime,
  createToolApprovalIteratorFromRuntime,
  createToolResumeIteratorFromRuntime,
} from '../mastra/attempt-legs';
import { listSuspendedMastraRuns } from '../mastra/suspended-run-discovery';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

it.each(['shell', 'mcp'] as const)(
  'projects background Worker %s progress under its observed child identity',
  async (kind) => {
    const fixture = await createBackgroundFixture(false, undefined, false, undefined, true, 1, {
      customToolOutput: kind,
    });
    const { backing, database, release, runtime, runtimeData } = fixture;
    release.resolve();
    try {
      const chunks: StreamChunk[] = [];
      for await (const chunk of await createStreamIteratorFromRuntime({
        memory: backing.memory,
        messages: [
          { id: 'shell-output', parts: [{ text: 'Run command', type: 'text' }], role: 'user' },
        ],
        runtime,
        runtimeData,
      })) {
        chunks.push(chunk);
      }
      const progress = chunks.find(
        (chunk) =>
          chunk.type === 'delegated-conversation-chunk' &&
          (kind === 'shell'
            ? chunk.chunk.type === 'shell-output'
            : chunk.chunk.type === 'tool-event' && chunk.chunk.status === 'progress')
      );
      expect(progress).toMatchObject({
        identity: {
          childRuntimeRunId: expect.any(String),
          parentRuntimeRunId: expect.any(String),
          parentToolCallId: 'background-child',
          personaId: 'explore',
        },
        messageId: expect.any(String),
        type: 'delegated-conversation-chunk',
      });
      expect(progress).toMatchObject(
        kind === 'shell'
          ? { chunk: { toolCallId: 'background-read' } }
          : { chunk: { payload: { toolCallId: 'background-read' } } }
      );
      expect(
        chunks.some((chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed')
      ).toBe(false);
    } finally {
      release.resolve();
      await runtime.dispose();
      await database.close();
    }
  }
);

it.each(['shell', 'mcp'] as const)(
  'projects a background Worker %s slice after fresh approval resumes',
  async (kind) => {
    const fixture = await createBackgroundFixture(true, undefined, false, undefined, true, 1, {
      customToolOutput: kind,
    });
    const { backing, database, discoveryOptions, release, runtime, runtimeData, scope } = fixture;
    const first: StreamChunk[] = [];
    let resumedRuntime: Awaited<ReturnType<typeof createMastraAgentRuntime>> | undefined;
    release.resolve();
    try {
      for await (const chunk of await createStreamIteratorFromRuntime({
        memory: backing.memory,
        messages: [
          { id: 'approve-shell', parts: [{ text: 'Run command', type: 'text' }], role: 'user' },
        ],
        runtime,
        runtimeData,
      })) {
        first.push(chunk);
      }
      expect(first.some((chunk) => chunk.type === 'tool-approval-required')).toBe(true);
      const pending = await listSuspendedMastraRuns(scope, discoveryOptions);
      const approval = pending.approvals.find(
        (item) => item.delegation?.toolCallId === 'background-read'
      );
      if (!approval) {
        throw new Error('Expected pending Worker command approval.');
      }
      resumedRuntime = await createMastraAgentRuntime(discoveryOptions);
      const resumed: StreamChunk[] = [];
      for await (const chunk of await createToolApprovalIteratorFromRuntime({
        action: {
          action: 'approve',
          runId: approval.runId,
          toolCallId: approval.toolCallId,
          ...(approval.delegation ? { delegation: approval.delegation } : {}),
        },
        memory: backing.memory,
        runtime: resumedRuntime,
        runtimeData,
      })) {
        resumed.push(chunk);
      }
      const progressIndex = resumed.findIndex(
        (chunk) =>
          chunk.type === 'delegated-conversation-chunk' &&
          (kind === 'shell'
            ? chunk.chunk.type === 'shell-output'
            : chunk.chunk.type === 'tool-event' && chunk.chunk.status === 'progress')
      );
      const startIndex = resumed.findIndex(
        (chunk) =>
          chunk.type === 'delegated-conversation-chunk' &&
          chunk.chunk.type === 'tool-event' &&
          chunk.chunk.status === 'start' &&
          typeof chunk.chunk.payload === 'object' &&
          chunk.chunk.payload !== null &&
          'toolCallId' in chunk.chunk.payload &&
          chunk.chunk.payload.toolCallId === 'background-read'
      );
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(progressIndex).toBeGreaterThan(startIndex);
      expect(resumed[progressIndex]).toMatchObject({
        identity: approval.delegation?.path.at(-1),
        messageId: expect.any(String),
      });
    } finally {
      await resumedRuntime?.dispose();
      await runtime.dispose();
      await database.close();
    }
  }
);

it.each(['shell', 'mcp'] as const)(
  'projects background Worker %s progress after fresh typed suspension resumes',
  async (kind) => {
    const fixture = await createBackgroundFixture(false, undefined, true, undefined, true, 1, {
      customSuspendedToolOutput: kind,
    });
    const { backing, database, discoveryOptions, release, runtime, runtimeData, scope } = fixture;
    let resumedRuntime: Awaited<ReturnType<typeof createMastraAgentRuntime>> | undefined;
    release.resolve();
    try {
      for await (const _chunk of await createStreamIteratorFromRuntime({
        memory: backing.memory,
        messages: [
          { id: 'typed-progress', parts: [{ text: 'Ask then read', type: 'text' }], role: 'user' },
        ],
        runtime,
        runtimeData,
      })) {
        // Wait for the native child suspension to persist.
      }
      const pending = await listSuspendedMastraRuns(scope, discoveryOptions);
      const pause = pending.suspends.find(
        (item) => item.delegation?.toolCallId === 'background-question'
      );
      if (!pause) {
        throw new Error('Expected pending native child suspension.');
      }
      resumedRuntime = await createMastraAgentRuntime(discoveryOptions);
      const chunks: StreamChunk[] = [];
      for await (const chunk of await createToolResumeIteratorFromRuntime({
        action: {
          resumeData: { answer: 'Inspect evidence' },
          runId: pause.runId,
          toolCallId: pause.toolCallId,
          ...(pause.delegation ? { delegation: pause.delegation } : {}),
        },
        memory: backing.memory,
        runtime: resumedRuntime,
        runtimeData,
      })) {
        chunks.push(chunk);
      }
      const startIndex = chunks.findIndex(
        (chunk) =>
          chunk.type === 'delegated-conversation-chunk' &&
          chunk.chunk.type === 'tool-event' &&
          chunk.chunk.status === 'start' &&
          chunk.chunk.name === 'brainstrike_askUser'
      );
      const progressIndex = chunks.findIndex(
        (chunk) =>
          chunk.type === 'delegated-conversation-chunk' &&
          (kind === 'shell'
            ? chunk.chunk.type === 'shell-output'
            : chunk.chunk.type === 'tool-event' && chunk.chunk.status === 'progress')
      );
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(progressIndex).toBeGreaterThan(startIndex);
      expect(chunks[progressIndex]).toMatchObject({
        identity: pause.delegation?.path.at(-1),
        messageId: expect.any(String),
      });
    } finally {
      release.resolve();
      await resumedRuntime?.dispose();
      await runtime.dispose();
      await database.close();
    }
  }
);
