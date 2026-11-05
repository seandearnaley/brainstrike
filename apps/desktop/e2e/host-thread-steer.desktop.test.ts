import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readAgentHostLog } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-steer';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const FIRST_PROMPT = 'Read evidence.txt, then summarise it.';
const UNSTEERED_REPLY = 'The run answered without the steering message.';
const STEER = 'Stop there and tell me the file name instead.';
const STEERED_REPLY = 'The run read the steering message at its next step.';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
}

test('a steered message reaches the running run at its next step, in the same run', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  await enableModel(page);
  const toolFinish = Promise.withResolvers<void>();
  modelProvider.setScript((request) => {
    if (JSON.stringify(request.messages).includes(STEER)) {
      return { finalText: STEERED_REPLY };
    }
    const name = request.toolNames.find((tool) => tool.endsWith('readWorkspaceFile'));
    return name
      ? {
          beforeToolFinish: toolFinish.promise,
          finalText: UNSTEERED_REPLY,
          toolCall: { arguments: { path: 'evidence.txt' }, name },
        }
      : { finalText: `No readWorkspaceFile tool offered: ${request.toolNames.join(', ')}` };
  });
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  await input.fill(FIRST_PROMPT);
  await region.getByRole('button', { exact: true, name: 'Send' }).click();

  // The run's tool step is held at the provider until the steer is committed.
  const steer = region.getByRole('button', { exact: true, name: 'Steer' });
  await expect(steer).toBeVisible({ timeout: 60_000 });
  await input.fill(STEER);
  await steer.click();
  await expect(input).toHaveValue('');
  await expect(region.getByText(STEER)).toBeVisible({ timeout: 30_000 });
  await expect(region.getByRole('list', { name: 'Queued follow-up messages' })).toHaveCount(0);

  toolFinish.resolve();
  await expect(region.getByText(STEERED_REPLY)).toBeVisible({ timeout: 90_000 });
  await expect(region.getByText(UNSTEERED_REPLY)).toHaveCount(0);
  // One request carried the message: the step after the tool, with the tool's result before it.
  const steering = modelProvider
    .requests()
    .filter((request) => JSON.stringify(request.messages).includes(STEER));
  expect(steering).toHaveLength(1);
  const messages = steering[0]?.messages ?? [];
  const toolResult = messages.findIndex((message) => {
    const { role, type } = message as { readonly role?: unknown; readonly type?: unknown };
    return role === 'tool' || type === 'function_call_output';
  });
  const steered = messages.findIndex((message) => JSON.stringify(message).includes(STEER));
  expect(toolResult).toBeGreaterThan(-1);
  expect(toolResult).toBeLessThan(steered);
  const log = await readAgentHostLog(electron.getUserDataDir());
  expect(log.typeCounts['run.started']).toBe(1);
  expect(log.typeCounts['run.finished']).toBe(1);
  expect(modelProvider.refusals()).toEqual([]);
});
