import {
  buildNativeToolRiskMap,
  getToolActionIdentityKey,
  getToolActionTarget,
  INTERNAL_FAULT,
} from '@brainstrike/assistant-contract';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { createTool } from '@mastra/core/tools';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  streamMastraChildFollowup,
  streamMastraToolApprovalAction,
  streamMastraToolResumeAction,
} from '../mastra/agent-streaming';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import type { ChildContinuationHostPort } from '../mastra/child-continuation-host-port';
import { listSuspendedChildContinuation } from '../mastra/suspended-run-discovery';
import { DataStreamMapper } from '../stream/data-stream-mapper';
import {
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../test-fixtures/scripted-agent-model';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

it.each([
  'complete',
  'approve',
  'parallel-approve',
  'parallel-question',
  'decline',
  'question',
  'question-twice',
  'plan',
  'cancel',
  'bind-failure',
  'mid-stream-failure',
  'provider-failure',
  'depth-limit',
  'depth-available',
  'nested-approve',
  'nested-question',
  'resume-then-delegate',
] as const)('wakes an idle child and preserves exact continuation decisions (%s)', async (mode) => {
  // Only a worker child may delegate (read-only personas are leaves).
  const fixture = await createBackgroundFixture(
    false,
    undefined,
    'available',
    false,
    NESTED_MODES.has(mode)
  );
  const failureLogs: LogRecord[] = [];
  const removeLogListener = addLogListener((record) => {
    if (mode === 'provider-failure') {
      failureLogs.push(record);
    }
  });
  try {
    fixture.release.resolve();
    const initial = await createStreamIteratorFromRuntime({
      memory: fixture.backing.memory,
      messages: [
        { id: 'first-task', parts: [{ text: 'Inspect evidence', type: 'text' }], role: 'user' },
      ],
      runtime: fixture.runtime,
      runtimeData: fixture.runtimeData,
    });
    const first: StreamChunk[] = [];
    for await (const chunk of initial) {
      first.push(chunk);
    }
    const firstChild = first.find((chunk) => chunk.type === 'delegated-conversation-chunk');
    if (firstChild?.type !== 'delegated-conversation-chunk') {
      throw new Error('Native child missing');
    }
    const original = firstChild.identity;
    const originalBinding = fixture.discoveryOptions.conversationBinding;
    const originalPersonas = fixture.discoveryOptions.personas;
    if (!originalPersonas) {
      throw new Error('Original persona registry missing');
    }
    if (!originalBinding) {
      throw new Error('Original child host binding missing');
    }
    const stored = await fixture.discoveryOptions.conversationBinding?.resolveToolAction?.({
      delegation: { path: [original], toolCallId: 'read' },
      runId: original.parentRuntimeRunId,
      toolCallId: original.parentToolCallId,
    });
    const scope = stored?.[0];
    if (!scope) {
      throw new Error('Original child scope missing');
    }
    const id = 'human-followup';
    const baseline = {
      hostRunId: 'new-host-run',
      messages: [],
      runEvents: [],
      threadId: scope.threadId,
    };
    let resumedLeg = 0;
    const port: ChildContinuationHostPort = {
      bindContinuation: vi.fn(async () => {
        if (mode === 'bind-failure') {
          throw new Error('Durable bind refused');
        }
        return { baseline, messageId: 'child-followup-message', threadId: scope.threadId };
      }),
      claimContinuationDecision: vi.fn(async () => {}),
      finishContinuation: vi.fn(async () => {}),
      finishContinuationDecision: vi.fn(),
      persistContinuationEvent: vi.fn(async () => {
        if (mode === 'mid-stream-failure') {
          throw new Error('Continuation event persistence failed');
        }
      }),
      persistContinuationUsage: vi.fn(async () => {}),
      prepareContinuation: vi.fn(async () => ({
        depth: mode === 'depth-limit' ? 3 : 1,
        id,
        ...scope,
        configuration: scope.configuration,
        messageId: 'child-followup-message',
        parentThreadId: fixture.scope.threadId,
      })),
      releaseUnexecutedContinuationDecision: vi.fn(),
      resolveContinuationDecision: vi.fn(async () => ({
        depth: 1,
        id,
        ...scope,
        baseline,
        configuration: scope.configuration,
        messageId: `resumed-child-message-${++resumedLeg}`,
        parentThreadId: fixture.scope.threadId,
      })),
    };
    const controller = new AbortController();
    const continuationEntered = Promise.withResolvers<void>();
    const cancelledEffect = vi.fn(
      async (_input: unknown, context: { abortSignal?: AbortSignal } | undefined) => {
        const signal = context?.abortSignal;
        if (!signal) {
          throw new Error('Continuation tool missing native abort signal.');
        }
        continuationEntered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return { matches: [] };
      }
    );
    const reserveStep = vi.fn(async () => ({
      id: 'step-reservation',
      outputTokens: 2048,
      synthesis: false as const,
    }));
    const parallelEffect = vi.fn(async ({ pattern }: { pattern: string }) => ({
      matches: [pattern],
    }));
    let step = 0;
    const model = scriptedAgentModel(() => {
      step += 1;
      if (mode === 'parallel-approve' && step === 1) {
        const first = toolCallParts('brainstrike_grepSearch', 'idle-leaf', { pattern: 'FIRST' });
        const second = toolCallParts('brainstrike_grepSearch', 'idle-second-leaf', {
          pattern: 'SECOND',
        });
        return [...first.slice(0, -1), ...second.slice(1)];
      }
      if (mode === 'parallel-question' && step === 1) {
        const first = toolCallParts('brainstrike_askUser', 'idle-question', {
          question: 'First evidence?',
        });
        const second = toolCallParts('brainstrike_askUser', 'idle-second-question', {
          question: 'Second evidence?',
        });
        return [...first.slice(0, -1), ...second.slice(1)];
      }
      if (mode === 'provider-failure') {
        throw new Error('Provider refused continuation: /Users/fixture/private/workspace.ts', {
          cause: new Error('ENOENT /Users/fixture/private/credentials.json'),
        });
      }
      if (step === 1 && (mode === 'nested-approve' || mode === 'nested-question')) {
        return toolCallParts('agent-explore', 'idle-nested-delegation', {
          _background: { enabled: false },
          prompt: 'Inspect nested evidence',
        });
      }
      if (step === 2 && mode === 'resume-then-delegate') {
        return toolCallParts('agent-explore', 'idle-after-question', {
          _background: { enabled: false },
          prompt: 'Inspect nested evidence',
        });
      }
      if (step === 2 && mode === 'nested-approve') {
        return toolCallParts('brainstrike_grepSearch', 'idle-nested-leaf', { pattern: 'NESTED' });
      }
      if (step === 2 && mode === 'nested-question') {
        return toolCallParts('brainstrike_askUser', 'idle-nested-question', {
          question: 'Which nested evidence?',
        });
      }
      if (
        (step === 1 && (mode === 'question' || mode === 'resume-then-delegate')) ||
        (mode === 'question-twice' && step <= 2)
      ) {
        return toolCallParts(
          'brainstrike_askUser',
          step === 2 ? 'idle-second-question' : 'idle-question',
          {
            question: 'Which evidence?',
          }
        );
      }
      if (step === 1 && mode === 'plan') {
        return toolCallParts('brainstrike_submitPlan', 'idle-plan', {
          overview: 'Use saved evidence',
          steps: [{ title: 'Summarize evidence' }],
          title: 'Read evidence',
        });
      }
      return (mode === 'approve' || mode === 'decline' || mode === 'cancel') && step === 1
        ? toolCallParts('brainstrike_grepSearch', 'idle-leaf', { pattern: 'IDLE' })
        : textParts('IDLE_CHILD_FOLLOWUP_RESULT');
    });
    const options = {
      ...fixture.discoveryOptions,
      getDelegatedSystemContext: () => [
        { content: 'WORKSPACE_SCOPE_1723', role: 'system' as const },
      ],
      modelOverride: model.model,
      personas:
        mode === 'depth-limit' ||
        mode === 'depth-available' ||
        mode === 'nested-approve' ||
        mode === 'nested-question' ||
        mode === 'resume-then-delegate'
          ? originalPersonas
          : [],
      runtime: {
        ...fixture.runtimeData,
        assistantMessageId: 'parent-outcome-message',
        permissionPolicy: {
          policies: {
            edit: 'deny' as const,
            execute: 'deny' as const,
            mcp: 'deny' as const,
            read:
              mode === 'approve' ||
              mode === 'parallel-approve' ||
              mode === 'decline' ||
              mode === 'nested-approve'
                ? ('ask' as const)
                : ('allow' as const),
          },
          riskByTool: buildNativeToolRiskMap(),
          yolo: false,
        },
        signal: controller.signal,
      },
      ...(mode === 'cancel' || mode === 'parallel-approve'
        ? {
            tools: {
              ...fixture.discoveryOptions.tools,
              'brainstrike.grepSearch': createTool({
                description: 'Read evidence',
                execute: mode === 'cancel' ? cancelledEffect : parallelEffect,
                id: 'brainstrike.grepSearch',
                inputSchema: z.object({ pattern: z.string() }),
              }),
            },
          }
        : {}),
      conversationBinding: {
        ...originalBinding,
        budget: {
          admitInvocation: async () => ({ admitted: true as const }),
          readTurnLimits: async () => undefined,
          reserveStep,
          settleStep: vi.fn(async () => {}),
        },
        continuation: port,
      },
    };
    const { getDelegatedSystemContext: _contextAlreadyInSnapshot, ...resumeOptions } = options;
    if (mode === 'bind-failure') {
      await expect(
        streamMastraChildFollowup({ id, text: 'FOLLOWUP_TEXT', threadId: scope.threadId }, options)
      ).rejects.toThrow('Durable bind refused');
      expect(port.finishContinuation).toHaveBeenLastCalledWith({
        error: 'Child continuation initialization failed.',
        id,
        status: 'failed',
      });
      const settled = await fixture.database.query('SELECT 1 AS settled');
      expect(settled.rows).toEqual([{ settled: 1 }]);
      return;
    }
    const stream = await streamMastraChildFollowup(
      { id, text: 'FOLLOWUP_TEXT', threadId: scope.threadId },
      options
    );
    const chunks: StreamChunk[] = [];
    const consumption = (async () => {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
    })();
    if (mode === 'mid-stream-failure') {
      await expect(consumption).rejects.toThrow('Continuation event persistence failed');
      expect(port.finishContinuation).toHaveBeenLastCalledWith({
        error: 'Continuation event persistence failed',
        id,
        status: 'failed',
      });
      expect((await fixture.database.query('SELECT 1 AS settled')).rows).toEqual([{ settled: 1 }]);
      return;
    }
    if (mode === 'provider-failure') {
      await consumption;
      expect(port.finishContinuation).toHaveBeenLastCalledWith({
        error: INTERNAL_FAULT.message,
        id,
        status: 'failed',
      });
      const visibleFailures = chunks.flatMap((chunk) => {
        if (chunk.type !== 'child-continuation-chunk') {
          return [];
        }
        if (chunk.chunk.type === 'text-delta') {
          return [chunk.chunk.value];
        }
        if (chunk.chunk.type === 'run-event' && chunk.chunk.event.kind === 'run.failed') {
          return [chunk.chunk.event.detail];
        }
        return [];
      });
      expect(visibleFailures).toContain(INTERNAL_FAULT.message);
      expect(JSON.stringify(visibleFailures)).not.toContain('Provider refused continuation');
      expect(JSON.stringify(chunks)).not.toContain('/Users/fixture/private/');
      expect(
        failureLogs
          .flatMap((record) => record.args)
          .some(
            (arg) =>
              typeof arg === 'object' &&
              arg !== null &&
              'cause' in arg &&
              JSON.stringify(arg.cause).includes('Provider refused continuation') &&
              JSON.stringify(arg.cause).includes('ENOENT /Users/fixture/private/credentials.json')
          )
      ).toBe(true);
      expect(JSON.stringify(model.prompts)).not.toContain('child_continuation_result');
      return;
    }
    if (mode === 'cancel') {
      await Promise.race([
        continuationEntered.promise,
        consumption.then(() => {
          throw new Error(`Continuation ended before its tool started: ${JSON.stringify(chunks)}`);
        }),
      ]);
      controller.abort(new Error('Stop exact child continuation'));
    }
    await consumption;
    expect(reserveStep).toHaveBeenCalledWith({
      resourceId: scope.resourceId,
      threadId: scope.threadId,
    });
    if (mode === 'cancel') {
      expect(cancelledEffect).toHaveBeenCalledOnce();
      expect(port.finishContinuation).toHaveBeenLastCalledWith({ id, status: 'cancelled' });
      return;
    }
    if (
      mode === 'approve' ||
      mode === 'parallel-approve' ||
      mode === 'decline' ||
      mode === 'nested-approve'
    ) {
      const pause = chunks.find(
        (chunk) =>
          chunk.type === 'child-continuation-chunk' && chunk.chunk.type === 'tool-approval-required'
      );
      if (
        pause?.type !== 'child-continuation-chunk' ||
        pause.chunk.type !== 'tool-approval-required'
      ) {
        throw new Error('Continuation approval missing');
      }
      expect(port.finishContinuation).toHaveBeenLastCalledWith({
        id,
        status: 'awaiting-approval',
      });
      expect(fixture.effect).toHaveBeenCalledOnce();
      expect(pause.chunk.continuationId).toBe(id);
      const modelCallsBeforeDiscovery = model.prompts.length;
      const discovered = await listSuspendedChildContinuation(
        {
          continuationId: id,
          nativeRunId: pause.nativeRunId,
          personaId: original.personaId,
          resourceId: scope.resourceId,
          threadId: scope.threadId,
        },
        {
          resolveInvocation: fixture.discoveryOptions.delegatedSuspensionDiscovery,
          storage: fixture.backing.storage,
        }
      );
      if (mode === 'parallel-approve') {
        expect(discovered.approvals.map((entry) => entry.toolCallId)).toEqual(['idle-leaf']);
        expect(parallelEffect).not.toHaveBeenCalled();
      }
      const pending = discovered.approvals[0];
      if (!pending) {
        throw new Error('Saved continuation approval missing');
      }
      expect(model.prompts).toHaveLength(modelCallsBeforeDiscovery);
      expect(getToolActionTarget(pending)).toEqual(getToolActionTarget(pause.chunk));
      const resumed = await streamMastraToolApprovalAction(
        {
          action: mode === 'decline' ? 'decline' : 'approve',
          ...getToolActionTarget(pending),
        },
        resumeOptions
      );
      for await (const chunk of resumed) {
        chunks.push(chunk);
      }
      const answered = chunks.flatMap((chunk) =>
        chunk.type === 'child-continuation-chunk' && chunk.chunk.type === 'tool-approval-answered'
          ? [chunk.chunk]
          : []
      );
      expect(
        answered.some(
          (answer) => getToolActionIdentityKey(answer) === getToolActionIdentityKey(pending)
        )
      ).toBe(true);
      if (mode === 'parallel-approve') {
        expect(parallelEffect).toHaveBeenCalledTimes(1);
        expect(parallelEffect.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({ pattern: 'FIRST' })
        );
        const secondDiscovery = await listSuspendedChildContinuation(
          {
            continuationId: id,
            nativeRunId: pause.nativeRunId,
            personaId: original.personaId,
            resourceId: scope.resourceId,
            threadId: scope.threadId,
          },
          {
            resolveInvocation: fixture.discoveryOptions.delegatedSuspensionDiscovery,
            storage: fixture.backing.storage,
          }
        );
        expect(secondDiscovery.approvals.map((entry) => entry.toolCallId)).toEqual([
          'idle-second-leaf',
        ]);
        const secondPending = secondDiscovery.approvals[0];
        if (!secondPending) {
          throw new Error('Second parallel continuation approval missing');
        }
        const secondResume = await streamMastraToolApprovalAction(
          { action: 'approve', ...getToolActionTarget(secondPending) },
          resumeOptions
        );
        for await (const chunk of secondResume) {
          chunks.push(chunk);
        }
        expect(parallelEffect).toHaveBeenCalledTimes(2);
        expect(parallelEffect.mock.calls[1]?.[0]).toEqual(
          expect.objectContaining({ pattern: 'SECOND' })
        );
      }
      expect(port.claimContinuationDecision).toHaveBeenCalledWith({
        id,
        kind: 'tool-approval',
        nativeRunId: pause.nativeRunId,
        toolCallId: mode === 'nested-approve' ? 'idle-nested-delegation' : 'idle-leaf',
        ...(pause.chunk.delegation ? { delegation: pause.chunk.delegation } : {}),
      });
    }
    if (
      mode === 'question' ||
      mode === 'question-twice' ||
      mode === 'parallel-question' ||
      mode === 'plan' ||
      mode === 'nested-question' ||
      mode === 'resume-then-delegate'
    ) {
      const pause = chunks.find(
        (chunk) =>
          chunk.type === 'child-continuation-chunk' && chunk.chunk.type === 'tool-suspend-required'
      );
      if (
        pause?.type !== 'child-continuation-chunk' ||
        pause.chunk.type !== 'tool-suspend-required'
      ) {
        throw new Error('Continuation question missing');
      }
      expect(port.finishContinuation).toHaveBeenLastCalledWith({ id, status: 'awaiting-input' });
      const modelCallsBeforeDiscovery = model.prompts.length;
      const discovered = await listSuspendedChildContinuation(
        {
          continuationId: id,
          nativeRunId: pause.nativeRunId,
          personaId: original.personaId,
          resourceId: scope.resourceId,
          threadId: scope.threadId,
        },
        {
          resolveInvocation: fixture.discoveryOptions.delegatedSuspensionDiscovery,
          storage: fixture.backing.storage,
        }
      );
      expect(discovered.suspends).toHaveLength(1);
      const pending = discovered.suspends[0];
      if (!pending) {
        throw new Error('Saved continuation question missing');
      }
      expect(model.prompts).toHaveLength(modelCallsBeforeDiscovery);
      expect(getToolActionTarget(pending)).toEqual(getToolActionTarget(pause.chunk));
      const resumed = await streamMastraToolResumeAction(
        {
          ...getToolActionTarget(pending),
          resumeData: mode === 'plan' ? { action: 'approved' } : { answer: 'Saved evidence' },
        },
        resumeOptions
      );
      for await (const chunk of resumed) {
        chunks.push(chunk);
      }
      expect(port.claimContinuationDecision).toHaveBeenCalledWith({
        id,
        kind: 'tool-resume',
        nativeRunId: pause.nativeRunId,
        toolCallId:
          mode === 'question' ||
          mode === 'question-twice' ||
          mode === 'parallel-question' ||
          mode === 'resume-then-delegate'
            ? 'idle-question'
            : mode === 'nested-question'
              ? 'idle-nested-delegation'
              : 'idle-plan',
        ...(pause.chunk.delegation ? { delegation: pause.chunk.delegation } : {}),
      });
    }
    if (mode === 'question-twice' || mode === 'parallel-question') {
      const second = chunks.find(
        (chunk) =>
          chunk.type === 'child-continuation-chunk' &&
          chunk.chunk.type === 'tool-suspend-required' &&
          chunk.chunk.toolCallId === 'idle-second-question'
      );
      if (
        second?.type !== 'child-continuation-chunk' ||
        second.chunk.type !== 'tool-suspend-required'
      ) {
        throw new Error('Second native pause missing');
      }
      const secondDiscovery = await listSuspendedChildContinuation(
        {
          continuationId: id,
          nativeRunId: second.nativeRunId,
          personaId: original.personaId,
          resourceId: scope.resourceId,
          threadId: scope.threadId,
        },
        {
          resolveInvocation: fixture.discoveryOptions.delegatedSuspensionDiscovery,
          storage: fixture.backing.storage,
        }
      );
      expect(secondDiscovery.suspends).toHaveLength(1);
      const secondPending = secondDiscovery.suspends[0];
      if (!secondPending) {
        throw new Error('Saved second native question missing');
      }
      expect(getToolActionTarget(secondPending)).toEqual(getToolActionTarget(second.chunk));
      const resumed = await streamMastraToolResumeAction(
        { ...getToolActionTarget(secondPending), resumeData: { answer: 'Second evidence' } },
        resumeOptions
      );
      for await (const chunk of resumed) {
        chunks.push(chunk);
      }
      expect(
        vi
          .mocked(port.persistContinuationUsage)
          .mock.calls.map(([usage]) => [usage.inputTokens, usage.outputTokens])
      ).toEqual(
        mode === 'parallel-question'
          ? [
              [1, 1],
              [1, 1],
            ]
          : [
              [1, 1],
              [1, 1],
              [1, 1],
            ]
      );
    }
    if (mode === 'depth-available') {
      expect(model.prompts[0]?.tools?.some((tool) => tool.name.startsWith('agent-'))).toBe(true);
    }
    if (mode === 'depth-limit') {
      expect(model.prompts[0]?.tools?.some((tool) => tool.name.startsWith('agent-'))).toBe(false);
    }
    const mapper = new DataStreamMapper('parent-outcome-message');
    const wire = [
      ...mapper.initialChunks(),
      ...chunks.flatMap((chunk) => [...mapper.handleChunk(chunk)]),
    ];
    const baselines = chunks.filter(
      (chunk) => chunk.type === 'child-continuation-chunk' && chunk.baseline
    );
    expect(
      new Set(
        baselines.map((chunk) => (chunk.type === 'child-continuation-chunk' ? chunk.messageId : ''))
      ).size
    ).toBe(baselines.length);
    expect(wire.length).toBeGreaterThan(0);
    expect(port.bindContinuation).toHaveBeenCalledOnce();
    expect(port.bindContinuation).not.toHaveBeenCalledWith(
      expect.objectContaining({ nativeRunId: original.childRuntimeRunId })
    );
    expect(chunks.filter((chunk) => chunk.type === 'child-continuation-chunk')).not.toHaveLength(0);
    expect(chunks.some((chunk) => chunk.type === 'delegated-conversation-chunk')).toBe(
      mode === 'nested-approve' || mode === 'nested-question' || mode === 'resume-then-delegate'
    );
    for (const chunk of chunks) {
      if (chunk.type === 'delegated-conversation-chunk') {
        expect(chunk.continuationId).toBe(id);
      }
    }
    expect(JSON.stringify(chunks)).toContain('IDLE_CHILD_FOLLOWUP_RESULT');
    expect(JSON.stringify(chunks)).not.toContain('Trusted delegated context is missing');
    expect(JSON.stringify(model.prompts)).toContain('FOLLOWUP_TEXT');
    expect(JSON.stringify(model.prompts[0]).match(/WORKSPACE_SCOPE_1723/gu)).toHaveLength(1);
    expect(JSON.stringify(model.prompts)).toContain('CHILD_FINAL_EVIDENCE');
    const terminalUsage = chunks.flatMap((chunk) =>
      chunk.type === 'child-continuation-chunk' && chunk.chunk.type === 'message-finish'
        ? [
            {
              id,
              inputTokens: chunk.chunk.usage.promptTokens,
              outputTokens: chunk.chunk.usage.completionTokens,
            },
          ]
        : []
    );
    expect(terminalUsage.length).toBeGreaterThan(0);
    expect(terminalUsage.some((usage) => usage.inputTokens > 0 && usage.outputTokens > 0)).toBe(
      true
    );
    const reportedUsage = vi
      .mocked(port.persistContinuationUsage)
      .mock.calls.map(([usage]) => usage);
    expect(reportedUsage.length).toBeGreaterThan(0);
    expect(
      reportedUsage.every(
        (usage) => usage.id === id && usage.inputTokens > 0 && usage.outputTokens > 0
      )
    ).toBe(true);
    expect(port.finishContinuation).toHaveBeenLastCalledWith({ id, status: 'completed' });
    expect(
      chunks.some(
        (chunk) => chunk.type === 'text-delta' && chunk.value.includes('IDLE_CHILD_FOLLOWUP_RESULT')
      )
    ).toBe(true);
    expect(JSON.stringify(model.prompts)).toContain('child_continuation_result');
    const childHistory = await fixture.backing.memory.recall({
      perPage: false,
      resourceId: scope.resourceId,
      threadId: scope.threadId,
    });
    expect(childHistory.messages.some((message) => message.id === 'child-followup-message')).toBe(
      true
    );
    expect(childHistory.messages.some((message) => message.id === 'parent-outcome-message')).toBe(
      false
    );
    expect(fixture.effect).toHaveBeenCalledTimes(
      mode === 'approve' || mode === 'nested-approve' ? 2 : 1
    );
  } finally {
    removeLogListener();
    fixture.release.resolve();
    await fixture.runtime.dispose();
    await fixture.database.close();
  }
}); /** Modes whose child delegates further; the fixture registers its persona as a worker for them. */
const NESTED_MODES = new Set([
  'depth-limit',
  'depth-available',
  'nested-approve',
  'nested-question',
  'resume-then-delegate',
]);
