import { buildNativeToolRiskMap, getToolActionTarget } from '@brainstrike/assistant-contract';
import { BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract/personas';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createDelegatedConversationBinding,
  type DelegatedConversationIdentity,
  type DelegatedToolActionScope,
} from '../mastra/delegated-conversation-binding';
import type { DelegatedRunIdentity } from '../mastra/delegated-run-publication';
import { createScannedWorkspaceSkills } from '../skills/scanned-workspace-skills';
import { type SkillScanDeps, scanSkills } from '../skills/skill-scan';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../test-fixtures/scripted-agent-model';
import type { StreamChunk } from '../types';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as ReturnType<typeof scriptedAgentModel>['model'] | undefined },
}));
vi.mock('../providers/provider-factory', async (original) => ({
  ...(await original<typeof import('../providers/provider-factory')>()),
  createProvider: () => {
    if (!modelHolder.current) {
      throw new Error('Missing scripted model');
    }
    return modelHolder.current;
  },
}));
const { streamMastraAgent, streamMastraToolApprovalAction } = await import(
  '../mastra/agent-streaming'
);

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

// Runtime assembly and native approval are real; this in-memory host port is
// deliberately not another proof of desktop persistence or process restart.
it.for(['approve', 'decline'] as const)(
  'built-in worker preserves context and executes a guarded edit only after %s',
  async (action) => {
    const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
    expect(worker, 'The production built-in worker must be available after BST-1720').toBeDefined();
    if (!worker) {
      throw new Error('Built-in worker is not implemented');
    }
    const write = vi.fn(async (_input: { content: string; path: string }) => ({ written: true }));
    const preToolUse = vi.fn(async (_toolName: string, _toolInput: unknown) => ({
      decision: 'allow' as const,
    }));
    const postToolUse = vi.fn(async (_input: { toolName: string }) => ({}));
    const identities: DelegatedConversationIdentity[] = [];
    const scopes: DelegatedToolActionScope[] = [];
    const observedMessageIds = new Map<string, string>();
    const binding = {
      ...createDelegatedConversationBinding(async (identity) => {
        identities.push(identity);
      }),
      bindRun: async (identity: DelegatedRunIdentity) => {
        const child = identities.find(
          (entry) => entry.parentToolCallId === identity.parentToolCallId
        );
        if (!child) {
          throw new Error('Native child was not bound');
        }
        scopes.splice(0, scopes.length, {
          identity,
          ...(child.originalToolCall ? { originalToolCall: child.originalToolCall } : {}),
          resourceId: child.childResourceId,
          threadId: child.childThreadId,
        });
        const messageId = observedMessageIds.get(identity.childRuntimeRunId);
        return {
          threadId: child.childThreadId,
          ...(messageId ? { messageId } : {}),
        };
      },
      claimToolAction: async () => undefined,
      finishToolActions: async () => undefined,
      prepareToolAction: async () => undefined,
      releaseUnexecutedToolAction: async () => undefined,
      resolveToolAction: async () => scopes,
    };
    const childPrompts: unknown[] = [];
    const childTools: string[][] = [];
    const parentResults: unknown[] = [];
    modelHolder.current = scriptedAgentModel((options) => {
      if (options.tools?.some((tool) => tool.name === 'agent-worker')) {
        if (hasToolResult(options, 'agent-worker')) {
          parentResults.push(options.prompt);
          return textParts('PARENT_RECEIVED_WORKER_RESULT');
        }
        return toolCallParts('agent-worker', 'worker-delegation', {
          instructions: 'DELEGATED_TASK_DETAIL',
          prompt: 'Create the requested deliverable.',
        });
      }
      childPrompts.push(options.prompt);
      childTools.push(options.tools?.map((tool) => tool.name) ?? []);
      if (!hasToolResult(options, 'skill')) {
        return toolCallParts('skill', 'worker-skill', { name: 'worker-deliverable' });
      }
      return hasToolResult(options, 'brainstrike_writeWorkspaceFile')
        ? textParts('WORKER_DELIVERABLE_RESULT')
        : toolCallParts('brainstrike_writeWorkspaceFile', 'worker-edit', {
            content: 'disposable output',
            path: 'worker-output.txt',
          });
    }).model;
    const storage = new InMemoryStore({ id: `worker-${action}` });
    const memory = new Memory({ options: { generateTitle: false }, storage });
    const options = {
      conversationBinding: binding,
      memory,
      personas: [worker],
      runtime: {
        apiKey: 'test-key',
        hookRunner: { postToolUse, preToolUse },
        memory: { resourceId: `worker-resource-${action}`, threadId: `worker-root-${action}` },
        permissionPolicy: {
          policies: { edit: 'ask', execute: 'ask', mcp: 'deny', read: 'allow' },
          riskByTool: { ...buildNativeToolRiskMap(), 'brainstrike.writeWorkspaceFile': 'edit' },
          yolo: false,
        },
        provider: 'openai',
        workspaceSkills: makeWorkerSkills(),
      },
      storage,
      tools: {
        'brainstrike.writeWorkspaceFile': createTool({
          description: 'Write a disposable workspace deliverable.',
          execute: write,
          id: 'brainstrike.writeWorkspaceFile',
          inputSchema: z.object({ content: z.string(), path: z.string() }),
        }),
      },
    } as const;
    const initial = await drain(
      await streamMastraAgent(
        [
          {
            id: 'workspace-context',
            parts: [{ text: 'TRUSTED_WORKSPACE_CONVENTION', type: 'text' }],
            role: 'system',
          },
          {
            id: 'user',
            parts: [{ text: 'Delegate my deliverable to Worker.', type: 'text' }],
            role: 'user',
          },
        ],
        options
      )
    );
    // Preserve the actual stream-owned message id across runtime reconstruction,
    // as the durable host does when resume forwards a descendant before start.
    for (const frame of initial) {
      if (frame.type !== 'delegated-conversation-chunk') {
        continue;
      }
      observedMessageIds.set(frame.identity.childRuntimeRunId, frame.messageId);
    }
    expect(observedMessageIds.size).toBe(1);
    const pending = initial.find((chunk) => chunk.type === 'tool-approval-required');
    expect(pending).toBeDefined();
    expect(write).not.toHaveBeenCalled();
    expect(preToolUse.mock.calls.map(([name]) => name)).toEqual(['skill']);
    expect(postToolUse.mock.calls.map(([input]) => input.toolName)).toEqual(['skill']);
    if (pending?.type !== 'tool-approval-required') {
      throw new Error('Missing native child approval');
    }
    expect(pending.delegation).toBeDefined();
    const target = getToolActionTarget(pending);
    expect(target.runId).toBe(scopes[0]?.identity.parentRuntimeRunId);
    expect(target.toolCallId).toBe('worker-delegation');
    expect(target.delegation?.toolCallId).toBe('worker-edit');
    const resumed = await drain(
      await streamMastraToolApprovalAction(
        {
          action,
          ...target,
          toolName: pending.toolName,
        },
        options
      )
    );
    expect(write).toHaveBeenCalledTimes(action === 'approve' ? 1 : 0);
    const expectedHookTools =
      action === 'approve' ? ['skill', 'brainstrike.writeWorkspaceFile'] : ['skill'];
    expect(preToolUse.mock.calls.map(([name]) => name)).toEqual(expectedHookTools);
    expect(postToolUse.mock.calls.map(([input]) => input.toolName)).toEqual(expectedHookTools);
    if (action === 'approve') {
      expect(write).toHaveBeenCalledWith(
        { content: 'disposable output', path: 'worker-output.txt' },
        expect.anything()
      );
    }
    expect(JSON.stringify(resumed)).toContain('PARENT_RECEIVED_WORKER_RESULT');
    expect(JSON.stringify(parentResults)).toContain('WORKER_DELIVERABLE_RESULT');
    expect(JSON.stringify(parentResults)).not.toContain('SKILL_BODY_TOOL_PROVENANCE_1721');
    const firstPrompt = z
      .array(z.object({ content: z.unknown(), role: z.string() }))
      .parse(childPrompts[0]);
    expect(JSON.stringify(firstPrompt.filter((message) => message.role === 'system'))).toContain(
      'TRUSTED_WORKSPACE_CONVENTION'
    );
    expect(
      JSON.stringify(firstPrompt.filter((message) => message.role === 'system'))
    ).not.toContain('DELEGATED_TASK_DETAIL');
    expect(JSON.stringify(firstPrompt.filter((message) => message.role === 'user'))).toContain(
      'DELEGATED_TASK_DETAIL'
    );
    expect(childPrompts.length).toBeGreaterThan(1);
    for (const prompt of childPrompts) {
      const messages = z.array(z.object({ content: z.unknown(), role: z.string() })).parse(prompt);
      expect(JSON.stringify(messages.filter((message) => message.role === 'system'))).toContain(
        'TRUSTED_WORKSPACE_CONVENTION'
      );
      expect(JSON.stringify(messages.filter((message) => message.role === 'system'))).not.toContain(
        'DELEGATED_TASK_DETAIL'
      );
    }
    for (const [index, prompt] of childPrompts.entries()) {
      const messages = z.array(z.object({ content: z.unknown(), role: z.string() })).parse(prompt);
      const system = JSON.stringify(messages.filter((message) => message.role === 'system'));
      expect(system).toContain('<available_skills>');
      expect(system).toContain('worker-deliverable');
      expect(system).not.toContain('SKILL_BODY_TOOL_PROVENANCE_1721');
      expect(childTools[index]).toEqual(
        expect.arrayContaining(['skill', 'skill_read', 'skill_search'])
      );
      if (index > 0) {
        expect(JSON.stringify(messages.filter((message) => message.role === 'tool'))).toContain(
          'SKILL_BODY_TOOL_PROVENANCE_1721'
        );
      }
    }
    await memory.settled();
  }
);

function makeWorkerSkills() {
  const directory = '/worker/.brainstrike/skills';
  const skillDirectory = `${directory}/worker-deliverable`;
  const skillPath = `${skillDirectory}/SKILL.md`;
  const content =
    '---\nname: worker-deliverable\ndescription: Complete a bounded workspace deliverable.\n---\nSKILL_BODY_TOOL_PROVENANCE_1721';
  const deps: SkillScanDeps = {
    listDir: (requested) => {
      if (requested === directory) {
        return {
          entries: [{ isDirectory: true, isFile: false, name: 'worker-deliverable' }],
          inspected: 1,
          truncated: false,
        };
      }
      if (requested === skillDirectory) {
        return {
          entries: [{ isDirectory: false, isFile: true, name: 'SKILL.md' }],
          inspected: 1,
          truncated: false,
        };
      }
      return null;
    },
    readFile: (requested) =>
      requested === skillPath ? { content, ok: true } : { ok: false, reason: 'unreadable' },
  };
  return createScannedWorkspaceSkills({
    deps: {
      listDir: deps.listDir,
      readFileBytes: (requested) =>
        requested === skillPath
          ? { content: new TextEncoder().encode(content), ok: true }
          : { ok: false, reason: 'unreadable' },
      readFileText: deps.readFile,
    },
    scan: () =>
      scanSkills(
        {
          homeDir: '/home/user',
          roots: [{ absPath: '/worker', displayName: 'Worker', id: 'worker-root' }],
        },
        deps
      ),
  });
}
