import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readAgentHostLog } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-steer';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const FIRST_PROMPT = 'Read evidence.txt, then summarise it.';
const UNSTEERED_REPLY = 'The first run continued past its tool step.';
const STEER = 'Stop there and tell me the file name instead.';
const STEERED_REPLY = 'The steering message ran as the next turn.';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await page.evaluate(async (model) => {
    const db = (
      window as unknown as {
        electronAPI: { db: { query: (sql: string, params: unknown[]) => Promise<unknown> } };
      }
    ).electronAPI.db;
    await db.query('UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2', [
      model,
      'openrouter',
    ]);
  }, MODEL);
}

test('steering a host run ends it after its step in flight and sends the message next', async ({
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

  // The run's first step is held at the provider until the steer is in.
  const steer = region.getByRole('button', {
    name: 'Steer: send now, stopping the run at the next step',
  });
  await expect(steer).toBeVisible({ timeout: 60_000 });
  await input.fill(STEER);
  await steer.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Steering: stopping after this step' })
  ).toBeVisible();
  await expect(region.getByRole('list', { name: 'Queued follow-up messages' })).toContainText(
    STEER
  );

  toolFinish.resolve();
  await expect(region.getByText(STEERED_REPLY)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Steering: stopping after this step')).toHaveCount(0);
  // The steered run took no step after its tool: only the steering turn's
  // request carried that tool's result to the model.
  await expect(region.getByText(UNSTEERED_REPLY)).toHaveCount(0);
  const steering = new Set(
    modelProvider
      .requests()
      .filter((request) => JSON.stringify(request.messages).includes(STEER))
      .map((request) => request.requestIndex)
  );
  expect(steering.size).toBe(1);
  expect(
    modelProvider
      .transcript()
      .filter((turn) => turn.toolResultCount > 0 && !steering.has(turn.requestIndex))
  ).toEqual([]);
  const log = await readAgentHostLog(electron.getUserDataDir());
  expect(log.typeCounts['run.started']).toBe(2);
  expect(log.typeCounts['run.finished']).toBe(2);
  expect(modelProvider.refusals()).toEqual([]);
});
