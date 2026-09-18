import { TOOL_APPROVAL_ANSWERED_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { expect, it } from 'vitest';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import { DataStreamMapper } from '../stream/data-stream-mapper';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

const READ_ASK_POLICY = {
  policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
  riskByTool: { 'brainstrike.grepSearch': 'read' },
  yolo: false,
} as const;

it('publishes both consumed approvals while the root waits in text for a running sibling', async () => {
  const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
    heldSibling: 3,
    permissionPolicy: {
      ...READ_ASK_POLICY,
      perToolOverrides: { 'brainstrike.readWorkspaceFile': 'allow' },
    },
    siblings: 3,
    slowRootTurn: true,
  });
  const { backing, runtime, runtimeData, release, hold, database } = fixture;
  release.resolve();
  const mapper = new DataStreamMapper('root-message');
  const ready = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const notices: Extract<StreamChunk, { type: 'tool-approval-required' }>[] = [];
  let progress = false;
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
      if (chunk.type === 'text-delta' && chunk.value.includes('PARENT_USEFUL_PROGRESS')) {
        progress = true;
      }
      if (chunk.type === 'tool-approval-required') {
        notices.push(chunk);
      }
      if (progress && notices.length >= 2) {
        ready.resolve();
      }
      if (chunk.type === 'tool-approval-answered') {
        wireAnswers.push(encoded);
        answers += 1;
        if (answers === 2) {
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
    expect(notices).toHaveLength(2);
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
    expect(answers).toBe(2);
    for (const encoded of wireAnswers) {
      expect(encoded).toContainEqual(
        expect.objectContaining({
          value: expect.objectContaining({ name: TOOL_APPROVAL_ANSWERED_DATA_NAME }),
        })
      );
    }
    hold.resolve();
    await consuming;
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
      ).toMatch(/Read background evidence [123]/);
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
