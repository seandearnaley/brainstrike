import { setImmediate as nextTurn } from 'node:timers/promises';
import { TOOL_APPROVAL_ANSWERED_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { expect, it, vi } from 'vitest';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import { DataStreamMapper } from '../stream/data-stream-mapper';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

const READ_ASK_POLICY = {
  policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
  riskByTool: { 'brainstrike.grepSearch': 'read' },
  yolo: false,
} as const;

it('delivers four specialist results after consuming each read approval without borrowing parent actions', async () => {
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    durableWork: true,
    heldSibling: 4,
    permissionPolicy: {
      ...READ_ASK_POLICY,
      perToolOverrides: { 'brainstrike.readWorkspaceFile': 'allow' },
    },
    siblings: 4,
    slowRootTurn: true,
  });
  const { backing, runtime, runtimeData, release, hold, database } = fixture;
  release.resolve();
  const mapper = new DataStreamMapper('root-message');
  const ready = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const notices: Extract<StreamChunk, { type: 'tool-approval-required' }>[] = [];
  let progress = false;
  let parentText = '';
  let answers = 0;
  const wireAnswers: unknown[][] = [];
  const consuming = (async () => {
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        {
          id: 'previous-request',
          parts: [{ text: 'Prepare a canvas with four specialists.', type: 'text' }],
          role: 'user',
        },
        {
          id: 'parent-progress',
          parts: [
            {
              text: 'PARENT_ACTION: I launched four specialists and will create the canvas.',
              type: 'text',
            },
          ],
          role: 'assistant',
        },
        { id: 'grant-fanout', parts: [{ text: 'Survey', type: 'text' }], role: 'user' },
      ],
      runtime,
      runtimeData,
    })) {
      const encoded = [...mapper.handleChunk(chunk)];
      if (chunk.type === 'text-delta') {
        parentText += chunk.value;
      }
      if (chunk.type === 'text-delta' && chunk.value.includes('PARENT_USEFUL_PROGRESS')) {
        progress = true;
      }
      if (chunk.type === 'tool-approval-required') {
        notices.push(chunk);
      }
      if (progress && notices.length >= 3) {
        ready.resolve();
      }
      if (chunk.type === 'tool-approval-answered') {
        wireAnswers.push(encoded);
        answers += 1;
        if (answers === 3) {
          answered.resolve();
        }
      }
    }
  })();
  consuming.catch(() => {});
  try {
    await Promise.race([
      ready.promise,
      consuming.then(() => {
        throw new Error('Stream ended before grant');
      }),
    ]);
    expect(notices).toHaveLength(3);
    const notice = notices[0];
    if (!notice?.delegation) {
      throw new Error('Missing delegated approval');
    }
    await fixture.decide({
      action: {
        action: 'approve',
        delegation: notice.delegation,
        runId: notice.runId,
        toolCallId: notice.toolCallId,
      },
      permissionPolicy: {
        ...READ_ASK_POLICY,
        perToolOverrides: { 'brainstrike.readWorkspaceFile': 'allow' },
        sessionGrants: ['read'],
      },
    });
    await Promise.race([
      answered.promise,
      consuming.then(() => {
        throw new Error('Stream ended before answers');
      }),
    ]);
    expect(answers).toBe(3);
    for (const encoded of wireAnswers) {
      expect(encoded).toContainEqual(
        expect.objectContaining({
          value: expect.objectContaining({ name: TOOL_APPROVAL_ANSWERED_DATA_NAME }),
        })
      );
    }
    hold.resolve();
    await consuming;
    expect(parentText).toContain('PARENT_FINAL_OUTCOME');
    const tasks = (await database.query('SELECT status, result FROM mastra_background_tasks')).rows;
    expect(tasks).toHaveLength(4);
    for (const task of tasks) {
      expect(task).toMatchObject({
        result: expect.objectContaining({ text: 'CHILD_FINAL_EVIDENCE' }),
        status: 'completed',
      });
    }
    const childPrompts = fixture.model.prompts.filter(
      (options) => !options.tools?.some((tool) => tool.name === 'agent-explore')
    );
    expect(childPrompts.length).toBeGreaterThan(0);
    for (const options of childPrompts) {
      expect(JSON.stringify(options.prompt)).toContain('PARENT_ACTION');
      expect(
        JSON.stringify(options.prompt.filter((message) => message.role === 'assistant'))
      ).not.toContain('PARENT_ACTION');
      expect(
        JSON.stringify(options.prompt.filter((message) => message.role === 'user').at(-1))
      ).toMatch(/Read background evidence [1234]/);
    }
  } finally {
    release.resolve();
    hold.resolve();
    await Promise.allSettled([consuming]);
    try {
      await runtime.dispose();
    } finally {
      await database.close();
    }
  }
});

it('keeps an accepted approval through durable commit after the final running sibling finishes', async () => {
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    concurrentSiblings: true,
    heldSibling: 2,
    permissionPolicy: {
      ...READ_ASK_POLICY,
      perToolOverrides: { 'brainstrike.readWorkspaceFile': 'allow' },
    },
    siblings: 2,
    slowRootTurn: true,
  });
  const { runtime, backing, runtimeData, release, hold, database } = fixture;
  const commitEntered = Promise.withResolvers<void>();
  const commitRelease = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<Extract<StreamChunk, { type: 'tool-approval-required' }>>();
  const siblingReturned = Promise.withResolvers<void>();
  const binding = runtime.conversationBinding;
  if (!binding?.recordToolActionAnswers) {
    throw new Error('Missing host answer recorder');
  }
  const record = binding.recordToolActionAnswers;
  const recording = vi
    .spyOn(binding, 'recordToolActionAnswers')
    .mockImplementation(async (answers) => {
      commitEntered.resolve();
      await commitRelease.promise;
      await record(answers);
    });
  let ended = false;
  let parentText = '';
  let decision: Promise<void> | undefined;
  release.resolve();
  const consuming = (async () => {
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        { id: 'commit-boundary', parts: [{ text: 'Survey', type: 'text' }], role: 'user' },
      ],
      runtime,
      runtimeData,
    })) {
      if (chunk.type === 'tool-approval-required') {
        ready.resolve(chunk);
      }
      if (chunk.type === 'text-delta') {
        parentText += chunk.value;
      }
      if (
        chunk.type === 'run-event' &&
        chunk.event.kind === 'delegation.ledger' &&
        chunk.event.metadata?.['returned'] === 1
      ) {
        siblingReturned.resolve();
      }
    }
    ended = true;
  })();
  consuming.catch(() => {});
  try {
    const notice = await Promise.race([
      ready.promise,
      consuming.then(() => {
        throw new Error('No approval');
      }),
    ]);
    if (!notice.delegation) {
      throw new Error('Missing child approval address');
    }
    decision = fixture.decide({
      action: {
        action: 'approve',
        delegation: notice.delegation,
        runId: notice.runId,
        toolCallId: notice.toolCallId,
      },
    });
    decision.catch(() => {});
    await commitEntered.promise;
    hold.resolve();
    await Promise.race([
      siblingReturned.promise,
      consuming.then(() => {
        throw new Error('Closed before the accepted decision');
      }),
    ]);
    await nextTurn();
    expect(ended).toBe(false);
    expect(fixture.effect).not.toHaveBeenCalled();
    commitRelease.resolve();
    await decision;
    await consuming;
    expect(fixture.effect).toHaveBeenCalledTimes(1);
    expect(parentText).toContain('PARENT_FINAL_OUTCOME');
    const tasks = (await database.query('SELECT status FROM mastra_background_tasks')).rows;
    expect(tasks).toEqual([{ status: 'completed' }, { status: 'completed' }]);
  } finally {
    recording.mockRestore();
    commitRelease.resolve();
    hold.resolve();
    release.resolve();
    await Promise.allSettled([decision, consuming]);
    await runtime.dispose();
    await database.close();
  }
});
