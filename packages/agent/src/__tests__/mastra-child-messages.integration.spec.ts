import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import { Agent, createMessageSignal, signalToMastraDBMessage } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { parseMemoryRequestContext } from '@mastra/core/memory';
import { createTool, type ToolExecuteContext } from '@mastra/core/tools';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createChildInputContextProcessor } from '../mastra/child-input-context';
import { createDelegatedFollowupControl } from '../mastra/delegated-followup';
import { createPgliteMastraMemory } from '../pglite-mastra-memory';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../test-fixtures/scripted-agent-model';

it.each([false, true])(
  'delivers human input with structured images=%s to the active child and continues its same memory thread',
  async (withImage) => {
    const database = await createEnginePglite();
    const backing = await createPgliteMastraMemory({
      database: {
        exec: (sql) => database.exec(sql),
        query: (sql, args) => database.query(sql, args ? [...args] : undefined),
        transaction: (operation) =>
          database.transaction((tx) =>
            operation({
              exec: (sql) => tx.exec(sql),
              query: (sql, args) => tx.query(sql, args ? [...args] : undefined),
            })
          ),
      },
      memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let childScope: { threadId: string; resourceId: string } | undefined;
    const effect = vi.fn(async (_input: unknown, context?: ToolExecuteContext<unknown>) => {
      const memory = context?.requestContext
        ? parseMemoryRequestContext(context.requestContext)
        : undefined;
      if (!(memory?.thread?.id && memory.resourceId)) {
        throw new Error('Missing native child memory scope');
      }
      childScope = { resourceId: memory.resourceId, threadId: memory.thread.id };
      entered.resolve();
      await release.promise;
      return { inspected: true };
    });
    const childModel = scriptedAgentModel((options) => {
      const prompt = JSON.stringify(options.prompt);
      if (prompt.includes('IDLE_FOLLOWUP')) {
        return textParts('SAME_CHILD_CONTINUED');
      }
      if (!hasToolResult(options, 'inspect')) {
        return toolCallParts('inspect', 'held-inspection', {});
      }
      return textParts(
        prompt.includes('ACTIVE_FOLLOWUP') ? 'CHILD_RECEIVED_FOLLOWUP' : 'CHILD_MISSED_FOLLOWUP'
      );
    });
    const child = new Agent({
      description: 'Inspect evidence',
      id: 'worker',
      inputProcessors: [createChildInputContextProcessor()],
      instructions: 'Inspect evidence',
      memory: backing.memory,
      model: childModel.model,
      name: 'Worker',
      tools: {
        inspect: createTool({
          description: 'Inspect evidence',
          execute: effect,
          id: 'inspect',
          inputSchema: z.object({}),
        }),
      },
    });
    const parentModel = scriptedAgentModel((options) =>
      hasToolResult(options, 'agent-worker')
        ? textParts(
            JSON.stringify(options.prompt).includes('CHILD_RECEIVED_FOLLOWUP')
              ? 'PARENT_RECEIVED_OUTCOME'
              : 'PARENT_MISSED_OUTCOME'
          )
        : toolCallParts('agent-worker', 'delegate', { prompt: 'Inspect evidence' })
    );
    const parent = new Agent({
      agents: { worker: child },
      id: 'parent',
      instructions: 'Delegate inspection',
      memory: backing.memory,
      model: parentModel.model,
      name: 'Parent',
    });
    const host = new Mastra({ agents: { parent }, logger: false, storage: backing.storage });
    let consuming: Promise<unknown> | undefined;
    try {
      const stream = await parent.stream('Inspect evidence', {
        maxSteps: 4,
        memory: { resource: 'owner', thread: 'root' },
      });
      consuming = stream.getFullOutput();
      consuming.catch(() => {});
      await entered.promise;
      const active = child
        .listActiveThreadRuns()
        .find((run) => run.threadId === childScope?.threadId);
      if (!active) {
        throw new Error('No active native child');
      }
      expect(active.threadId).not.toBe('root');
      if (!childScope) {
        throw new Error('Missing observed child scope');
      }
      if (withImage) {
        const deliver = createDelegatedFollowupControl({ worker: child });
        const input = {
          attachments: [
            {
              data: 'data:image/png;base64,AQID',
              filename: 'evidence.png',
              mediaType: 'image/png',
              type: 'file' as const,
            },
          ],
          id: 'human-followup-request',
          text: 'ACTIVE_FOLLOWUP',
        };
        const target = {
          ...childScope,
          identity: {
            childRuntimeRunId: active.runId,
            parentRuntimeRunId: 'parent-run',
            parentToolCallId: 'delegate',
            personaId: 'worker',
          },
          personaId: 'worker',
          runId: active.runId,
        };
        const prepareContext = vi.fn(async () => [
          { content: 'HOST_FILE_CONTEXT_ONLY_CHILD', role: 'system' as const },
        ]);
        await deliver(target, input, async () => {}, prepareContext);
        await deliver(target, input, async () => {}, prepareContext);
        expect(prepareContext).toHaveBeenCalledOnce();
        await expect(
          deliver(
            target,
            {
              ...input,
              attachments: [
                {
                  data: 'data:image/png;base64,BAUG',
                  filename: 'evidence.png',
                  mediaType: 'image/png',
                  type: 'file',
                },
              ],
            },
            async () => {}
          )
        ).rejects.toThrow('different content');
      } else {
        const humanInput = createMessageSignal('ACTIVE_FOLLOWUP', { id: 'human-followup-request' });
        await backing.memory.saveMessages({
          messages: [signalToMastraDBMessage(humanInput, childScope)],
        });
        expect(await parent.sendSignal(humanInput, { runId: active.runId }).accepted).toMatchObject(
          {
            action: 'blocked',
          }
        );
        const delivery = child.sendSignal(humanInput, { runId: active.runId });
        expect(await delivery.accepted).toMatchObject({ action: 'deliver', runId: active.runId });
        expect(await child.sendSignal(humanInput, { runId: active.runId }).accepted).toMatchObject({
          action: 'deliver',
          runId: active.runId,
        });
      }
      release.resolve();
      expect(await consuming).toMatchObject({ text: 'PARENT_RECEIVED_OUTCOME' });
      expect(effect).toHaveBeenCalledOnce();
      expect(JSON.stringify(childModel.prompts.at(-1)).match(/ACTIVE_FOLLOWUP/g)).toHaveLength(1);
      if (withImage) {
        expect(JSON.stringify(childModel.prompts.at(-1))).toContain('image/png');
        expect(childModel.prompts.at(-1)?.prompt).toContainEqual({
          content: 'HOST_FILE_CONTEXT_ONLY_CHILD',
          role: 'system',
        });
        expect(JSON.stringify(parentModel.prompts)).not.toContain('HOST_FILE_CONTEXT_ONLY_CHILD');
      }
      const continued = await child.sendMessage('IDLE_FOLLOWUP', childScope).accepted;
      if (continued.action !== 'wake') {
        throw new Error(`Expected idle child wake, received ${continued.action}`);
      }
      expect(await continued.output.getFullOutput()).toMatchObject({
        text: 'SAME_CHILD_CONTINUED',
      });
      expect(effect).toHaveBeenCalledOnce();
      const saved = await backing.memory.recall({ ...childScope, perPage: false });
      expect(JSON.stringify(saved.messages)).toContain('ACTIVE_FOLLOWUP');
      expect(JSON.stringify(saved.messages)).toContain('IDLE_FOLLOWUP');
      if (withImage) {
        expect(JSON.stringify(saved.messages)).toContain('data:image/png;base64,AQID');
        expect(JSON.stringify(saved.messages)).toContain('HOST_FILE_CONTEXT_ONLY_CHILD');
      }
    } finally {
      release.resolve();
      await Promise.allSettled([consuming]);
      await host.shutdown();
      await database.close();
    }
  }
);
