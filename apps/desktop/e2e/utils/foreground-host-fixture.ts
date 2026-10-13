import { type HostParams, parseHostParams } from '@brainstrike/agent-host/protocol';
import { expect, type Page } from '@playwright/test';
import { withAppHost } from './agent-host-log';
import { configureAssistantProvider } from './assistant-mock';
import { ensureAssistantShellVisible } from './layout-helpers';
import type { ModelProviderShim } from './model-provider-shim';

const MODEL = 'anthropic/claude-sonnet-4.6';
export const FOREGROUND_PROBE_KEY = 'test-key-foreground-host-admission';
const PROMPT = 'Return the fixed foreground benchmark reply.';
const REPLY = 'Foreground benchmark reply.';

/** Capture the real Send configuration; Core owns both seed and measured runs. */
export async function seedHostAdmissionRun(
  page: Page,
  profile: string,
  provider: ModelProviderShim
): Promise<Omit<HostParams<'run/start'>, 'commandId'>> {
  provider.setScript({ finalText: REPLY });
  await configureAssistantProvider(page, {
    apiKey: FOREGROUND_PROBE_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await page.evaluate(async (model) => {
    if (!window.electronAPI) {
      throw new Error('Desktop bridge unavailable');
    }
    await window.electronAPI.db.query(
      'UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2',
      [model, 'openrouter']
    );
  }, MODEL);
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await region.getByRole('textbox', { name: 'Message input' }).fill(PROMPT);
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 60_000 });
  const selected = await page
    .getByRole('tablist', { name: 'Open assistant threads' })
    .getByRole('tab', { selected: true })
    .getAttribute('id');
  if (!selected?.startsWith('assistant-thread-tab-')) {
    throw new Error('No selected host thread after benchmark Send');
  }
  const threadId = selected.slice('assistant-thread-tab-'.length);
  return await withAppHost(profile, async (client) => {
    let input: HostParams<'run/start'> | undefined;
    await expect
      .poll(
        async () => {
          const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
          const accepted = rows.find(
            ({ event }) => event.type === 'command.accepted' && event.method === 'run/start'
          )?.event;
          if (accepted?.type !== 'command.accepted') {
            return false;
          }
          input = parseHostParams('run/start', accepted.payload);
          return rows.some(
            ({ event }) => event.type === 'run.finished' && event.outcome === 'completed'
          );
        },
        { timeout: 60_000 }
      )
      .toBe(true);
    if (!input?.configuration) {
      throw new Error('Real benchmark Send committed no configuration');
    }
    return {
      configuration: input.configuration,
      modelId: input.modelId,
      parentMessageId: null,
      prompt: PROMPT,
      threadId,
    };
  });
}
