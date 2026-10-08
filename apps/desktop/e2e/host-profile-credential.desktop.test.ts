import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { writePrivateCredentialFile } from '@brainstrike/agent-host/file-credentials';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const FINAL_TEXT = 'PROFILE_STORE_CREDENTIAL_RESOLVED';
const STORED_KEY = 'profile-store-openrouter-key';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';

/**
 * The forked Node host resolves provider credentials itself, from the profile's
 * credential store that Main's Settings writes. No provider env key is set (the
 * launch fixture scrubs them), so a completed run proves the host read the store.
 */
test('a host run authenticates from the profile credential store with no env key', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(180_000);
  const userData = electron.getUserDataDir();
  await mkdir(userData, { recursive: true });
  // An isolated test profile selects this private file, never the OS keychain.
  await writePrivateCredentialFile(
    path.join(userData, 'brainstrike-credentials.json'),
    JSON.stringify({
      records: {},
      secrets: { openrouter: JSON.stringify({ key: STORED_KEY, type: 'api_key' }) },
      version: 1,
    })
  );
  const page = await electron.ensureWindow();
  await configureAssistantProvider(page, {
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
  modelProvider.setScript({ finalText: FINAL_TEXT });

  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await region.getByRole('textbox', { name: 'Message input' }).fill('Say the proof phrase.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();

  await expect(region.getByText(FINAL_TEXT).first()).toBeVisible({ timeout: 90_000 });
  expect(modelProvider.requestCount()).toBeGreaterThan(0);
  expect(modelProvider.refusals()).toEqual([]);
});
