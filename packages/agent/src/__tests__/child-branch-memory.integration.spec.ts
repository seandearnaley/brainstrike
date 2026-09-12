import { MigrationRunner, migrations } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import { Agent, type MastraDBMessage } from '@mastra/core/agent';
import { expect, it } from 'vitest';
import { CHILD_BRANCH_MEMORY_OPTIONS, childBranchInputProcessors } from '../mastra/child-branch';
import type { AgentStreamOptions } from '../mastra/turn-attempts';
import { createPgliteMastraMemory } from '../pglite-mastra-memory';
import { scriptedAgentModel, textParts } from '../test-fixtures/scripted-agent-model';

it('historical child execution excludes later derived working memory and preserves native rows', async () => {
  const database = await createEnginePglite();
  try {
    const runner = new MigrationRunner(database);
    await runner.initialize();
    await runner.up(migrations);
    const backing = await createPgliteMastraMemory({
      database: database as unknown as Parameters<typeof createPgliteMastraMemory>[0]['database'],
      memoryOptions: {
        generateTitle: false,
        lastMessages: 1,
        workingMemory: { enabled: true, scope: 'thread' },
      },
    });
    const threadId = 'branch-child';
    const resourceId = 'branch-owner';
    await backing.memory.createThread({ resourceId, threadId });
    await backing.memory.updateWorkingMemory({
      resourceId,
      threadId,
      workingMemory: 'FUTURE_WORKING_MEMORY',
    });
    const originals: MastraDBMessage[] = [
      'SELECTED_USER',
      'OLD_ANSWER',
      'FUTURE_USER',
      'FUTURE_ANSWER',
    ].map((text, index) => ({
      content: { content: text, format: 2, parts: [{ text, type: 'text' }] },
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)),
      id: `branch-${index}`,
      resourceId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      threadId,
      type: 'text',
    }));
    await backing.memory.saveMessages({ messages: originals });
    const storedBefore = await backing.store.listMessages({ perPage: false, resourceId, threadId });
    const selected = storedBefore.messages.filter((message) => message.id === 'branch-0');
    const model = scriptedAgentModel(() => textParts('NEW_BRANCH_ANSWER'));
    const child = new Agent({
      id: 'historical-worker',
      instructions: 'ADMITTED_INSTRUCTIONS',
      memory: backing.memory,
      model: model.model,
      name: 'Worker',
    });
    const inputProcessors = await childBranchInputProcessors(child, {
      branch: { kind: 'retry', messageId: 'branch-1' },
      branchMessageIds: selected.map((message) => message.id),
      configuration: {},
      depth: 1,
      id: 'receipt',
      messageId: 'new-answer',
      parentThreadId: 'parent',
      resourceId,
      threadId,
    });
    if (!inputProcessors) {
      throw new Error('Missing selected child history processor.');
    }
    const stream = await child.stream([], {
      inputProcessors,
      maxSteps: 1,
      memory: { options: CHILD_BRANCH_MEMORY_OPTIONS, resource: resourceId, thread: threadId },
    } as AgentStreamOptions);
    await stream.consumeStream();
    const prompt = JSON.stringify(model.prompts);
    expect(prompt).toContain('SELECTED_USER');
    expect(prompt).toContain('ADMITTED_INSTRUCTIONS');
    expect(prompt).not.toContain('FUTURE_WORKING_MEMORY');
    expect(prompt).not.toContain('FUTURE_USER');
    expect(prompt).not.toContain('FUTURE_ANSWER');
    expect(await backing.memory.getWorkingMemory({ resourceId, threadId })).toBe(
      'FUTURE_WORKING_MEMORY'
    );
    const after = await backing.store.listMessages({ perPage: false, resourceId, threadId });
    for (const original of storedBefore.messages) {
      expect(after.messages.find((message) => message.id === original.id)).toEqual(original);
    }
    expect(after.messages).toHaveLength(5);
  } finally {
    await database.close();
  }
});
