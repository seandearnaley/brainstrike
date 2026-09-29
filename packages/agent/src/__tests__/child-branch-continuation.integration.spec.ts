import { buildNativeToolRiskMap, getToolActionTarget } from '@brainstrike/assistant-contract';
import { expect, it, vi } from 'vitest';
import {
  streamMastraChildFollowup,
  streamMastraToolApprovalAction,
} from '../mastra/agent-streaming';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import type { ChildContinuationHostPort } from '../mastra/child-continuation-host-port';
import {
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../test-fixtures/scripted-agent-model';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

it.each(['retry', 'edit'] as const)(
  'executes a historical child %s and resumes its exact approval without later history',
  async (kind) => {
    const fixture = await createBackgroundFixture(false, undefined, 'available', false);
    try {
      fixture.release.resolve();
      const originalChunks: StreamChunk[] = [];
      const initial = await createStreamIteratorFromRuntime({
        memory: fixture.backing.memory,
        messages: [
          {
            id: 'branch-original-task',
            parts: [{ text: 'Inspect evidence', type: 'text' }],
            role: 'user',
          },
        ],
        runtime: fixture.runtime,
        runtimeData: fixture.runtimeData,
      });
      for await (const chunk of initial) {
        originalChunks.push(chunk);
      }
      const original = originalChunks.find(
        (chunk) => chunk.type === 'delegated-conversation-chunk'
      );
      if (original?.type !== 'delegated-conversation-chunk') {
        throw new Error('No original delegated child');
      }
      const binding = fixture.discoveryOptions.conversationBinding;
      const [child] =
        (await binding?.resolveToolAction?.({
          delegation: { path: [original.identity], toolCallId: 'read' },
          runId: original.identity.parentRuntimeRunId,
          toolCallId: original.identity.parentToolCallId,
        })) ?? [];
      if (!(child && binding)) {
        throw new Error('No authorized child scope');
      }
      const before = await fixture.backing.store.listMessages({
        perPage: false,
        resourceId: child.resourceId,
        threadId: child.threadId,
      });
      const user = before.messages.find((message) => message.role === 'user');
      const answer = before.messages.find((message) => message.role === 'assistant');
      if (!(user && answer)) {
        throw new Error('No stored child prompt and answer');
      }
      await fixture.backing.memory.saveMessages({
        messages: [
          {
            content: {
              content: 'FUTURE_BRANCH_SECRET',
              format: 2,
              parts: [{ text: 'FUTURE_BRANCH_SECRET', type: 'text' }],
            },
            createdAt: new Date(),
            id: 'branch-future',
            resourceId: child.resourceId,
            role: 'user',
            threadId: child.threadId,
            type: 'text',
          },
        ],
      });
      const baseline = {
        hostRunId: 'branch-host',
        messages: [],
        runEvents: [],
        threadId: child.threadId,
      };
      const scope = {
        ...child,
        branch: { kind, messageId: kind === 'retry' ? answer.id : user.id },
        branchInputMessageId: 'branch-new-user',
        branchMessageIds: kind === 'retry' ? [user.id] : [],
        configuration: child.configuration ?? {},
        depth: 1,
        id: 'branch-receipt',
        messageId: 'branch-new-answer',
        parentThreadId: fixture.scope.threadId,
      };
      const port: ChildContinuationHostPort = {
        bindContinuation: vi.fn(async () => ({
          baseline,
          messageId: scope.messageId,
          threadId: child.threadId,
        })),
        claimContinuationDecision: vi.fn(async () => {}),
        finishContinuation: vi.fn(async () => {}),
        finishContinuationDecision: vi.fn(async () => {}),
        persistContinuationEvent: vi.fn(async () => {}),
        persistContinuationUsage: vi.fn(async () => {}),
        prepareContinuation: vi.fn(async () => scope),
        releaseUnexecutedContinuationDecision: vi.fn(async () => {}),
        resolveContinuationDecision: vi.fn(async () => ({
          ...scope,
          baseline,
          messageId: 'branch-resumed-answer',
        })),
      };
      let calls = 0;
      const model = scriptedAgentModel(() =>
        ++calls === 1
          ? toolCallParts('brainstrike_grepSearch', 'branch-approval', { pattern: 'BRANCH' })
          : textParts('HISTORICAL_BRANCH_RESULT')
      );
      const options = {
        ...fixture.discoveryOptions,
        conversationBinding: { ...binding, continuation: port },
        modelOverride: model.model,
        personas: [],
        runtime: {
          ...fixture.runtimeData,
          assistantMessageId: 'branch-parent-outcome',
          permissionPolicy: {
            policies: {
              edit: 'deny' as const,
              execute: 'deny' as const,
              mcp: 'deny' as const,
              read: 'ask' as const,
            },
            riskByTool: buildNativeToolRiskMap(),
            yolo: false,
          },
        },
      };
      const stream = await streamMastraChildFollowup(
        {
          branch: scope.branch,
          id: scope.id,
          text: kind === 'edit' ? 'EDITED_BRANCH_INPUT' : 'Retry',
          threadId: child.threadId,
        },
        options
      );
      const chunks: StreamChunk[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const pause = chunks.find(
        (chunk) =>
          chunk.type === 'child-continuation-chunk' && chunk.chunk.type === 'tool-approval-required'
      );
      if (
        pause?.type !== 'child-continuation-chunk' ||
        pause.chunk.type !== 'tool-approval-required'
      ) {
        throw new Error('No exact historical child approval');
      }
      expect(fixture.effect).toHaveBeenCalledOnce();
      expect(JSON.stringify(model.prompts)).not.toContain('FUTURE_BRANCH_SECRET');
      const resumed = await streamMastraToolApprovalAction(
        { ...getToolActionTarget(pause.chunk), action: 'approve' },
        options
      );
      for await (const chunk of resumed) {
        chunks.push(chunk);
      }
      expect(fixture.effect).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(model.prompts)).not.toContain('FUTURE_BRANCH_SECRET');
      expect(JSON.stringify(model.prompts)).toContain(
        kind === 'edit' ? 'EDITED_BRANCH_INPUT' : 'Inspect'
      );
      const after = await fixture.backing.store.listMessages({
        perPage: false,
        resourceId: child.resourceId,
        threadId: child.threadId,
      });
      for (const original of before.messages) {
        expect(after.messages.find((message) => message.id === original.id)).toEqual(original);
      }
      expect(after.messages.some((message) => message.id === scope.messageId)).toBe(true);
      expect(port.finishContinuation).toHaveBeenLastCalledWith({
        id: scope.id,
        status: 'completed',
      });
    } finally {
      await fixture.database.close();
    }
  }
);
