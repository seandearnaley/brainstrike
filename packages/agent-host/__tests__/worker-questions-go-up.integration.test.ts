/**
 * ADR-0028 rule 1: a child's questions go up. A `*` worker gets every tool
 * its parent admitted except the ones that wait on the person, so it can never
 * park on a question or a plan in a thread the person may not open.
 */
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import type { HostTool } from '../src/ports.js';
import {
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
  userTexts,
  worker,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const TASK = 'CHILD_TASK: write the notes.';

const submitPlan: HostTool = {
  description: 'Submit a plan for the user to approve',
  execute: async (_input, context) => context.resumeData,
  identity: 'native-submit-plan-generation-1',
  inputSchema: z.object({ plan: z.string() }),
  interaction: { kind: 'plan', resumeSchema: z.object({ action: z.string() }) },
  permissionToolId: NATIVE_TOOL_ID.submitPlan,
  risk: 'read',
};

test('a wildcard worker is offered every parent tool except asking the person and submitting a plan', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (userTexts(call).some((input) => input.includes(TASK))) {
        return stream(text('Notes written.'));
      }
      const answered = call.prompt.some((message) => message.role === 'tool');
      return stream(
        answered
          ? text('Parent done.')
          : toolCall(
              'agent-worker',
              { _background: { disposition: 'awaited', enabled: true }, prompt: TASK },
              'delegate-1'
            )
      );
    },
  });
  const harness = await setupChildRunHost(model, cleanup, {
    personas: [worker],
    tools: { submit_plan: submitPlan },
  });

  const runId = await harness.start('Write the notes with a worker.');
  await rowsUntil(harness, harness.threadId, finished(runId), 10_000);

  const [parent] = model.doStreamCalls;
  const child = model.doStreamCalls.find((call) =>
    userTexts(call).some((input) => input.includes(TASK))
  );
  expect(parent && toolNames(parent)).toEqual(
    expect.arrayContaining(['ask_user', 'read_file', 'submit_plan'])
  );
  expect(child && toolNames(child)).toEqual([
    'agent-worker',
    'read_file',
    'run_command',
    'write_file',
  ]);
});
