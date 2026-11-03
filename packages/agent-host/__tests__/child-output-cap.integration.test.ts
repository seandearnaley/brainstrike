/**
 * A subagent's step may write as much as its model allows unless the user set
 * an output cap (Settings → Subagents → Subagent limits): a step cut short by a
 * cap ends the subagent as failed.
 */
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import {
  type CallOptions,
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
  userTexts,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const TASK = 'CAP_TASK: survey the workspace.';

function delegatingModel() {
  return new MockLanguageModelV4({
    doStream: async (call) => {
      if (userTexts(call).some((input) => input.startsWith('CAP_TASK'))) {
        return stream(text('Child outcome.'));
      }
      if (
        toolNames(call).includes('agent-explore') &&
        !call.prompt.some((message) => message.role === 'tool')
      ) {
        return stream(
          toolCall(
            'agent-explore',
            { _background: { enabled: false }, prompt: TASK },
            'cap-delegation'
          )
        );
      }
      return stream(text('Parent continues.'));
    },
  });
}

async function childCall(
  settings: Parameters<typeof setupChildRunHost>[2]
): Promise<CallOptions | undefined> {
  const model = delegatingModel();
  const harness = await setupChildRunHost(model, cleanup, settings);
  const runId = await harness.start('Delegate.');
  await rowsUntil(harness, harness.threadId, finished(runId), 5000);
  return model.doStreamCalls.find((call) =>
    userTexts(call).some((input) => input.startsWith('CAP_TASK'))
  );
}

test('a subagent step runs at the model’s own output limit by default', async () => {
  const call = await childCall({});
  expect(call).toBeDefined();
  expect(call?.maxOutputTokens).toBeUndefined();
});

test('a subagent step is capped at the output limit the user set', async () => {
  const call = await childCall({ settings: { maxStepOutputTokens: 4096 } });
  expect(call?.maxOutputTokens).toBe(4096);
});
