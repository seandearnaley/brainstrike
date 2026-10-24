import { readFile } from 'node:fs/promises';
import { parseOpenRouterModelMetadata } from '@brainstrike/assistant-contract';
import type { ElectronApplication } from 'playwright';

// Public Models API response recorded without credentials or inference.
const recordedModelMetadata = parseOpenRouterModelMetadata(
  JSON.parse(
    await readFile(
      new URL('../fixtures/openrouter-sonnet-4-6-model-metadata.json', import.meta.url),
      'utf8'
    )
  ),
  'anthropic/claude-sonnet-4.6',
  Date.parse('2026-10-07T05:07:09.516Z')
);
export async function routeRecordedModelMetadata(application: ElectronApplication): Promise<void> {
  // Only metadata HTTP is intercepted; tools/IPC/SQLite/view stay real.
  await application.context().route('**/assistant/openrouter-model?*', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ freshness: 'live', metadata: recordedModelMetadata }),
      contentType: 'application/json',
    });
  });
}
