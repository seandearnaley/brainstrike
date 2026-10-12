import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const LOCAL_MODEL = 'local::onnx-community/gemma-4-E2B-it-ONNX';
const FINAL_TEXT = 'HOST_THREAD_LOCAL_MODEL_ANSWERED';

// The launch scripts Main's hidden llm-host seam instead of downloading the
// model, including a cold load's progress on warmup.
test.use({
  electronEnv: {
    ['BRAINSTRIKE_E2E_LLM_HOST_SCRIPT']: JSON.stringify({ loading: true, text: FINAL_TEXT }),
  },
});

/**
 * A host thread on the built-in local model: the composer's run admits in the
 * forked Node host, which relays the generation over its private port to Main's
 * llm-host seam (ADR-0007: no model loads in the host). No provider egress. The
 * composer shows the cold load's progress that Main broadcasts.
 */
test('a host thread on the built-in local model answers through the llm-host seam', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(180_000);
  const page = await electron.ensureWindow();
  await configureAssistantProvider(page, { compositeModelKey: LOCAL_MODEL, provider: 'local' });
  await enableAssistantCatalogModel(page, LOCAL_MODEL);

  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  // The load badge is transient, so record every state it shows.
  await page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { localModelStatusTexts: seen });
    new MutationObserver(() => {
      const text = document.querySelector('[data-testid="local-model-status"]')?.textContent;
      if (text && seen.at(-1) !== text) {
        seen.push(text);
      }
    }).observe(document.body, { characterData: true, childList: true, subtree: true });
  });
  await region.getByRole('textbox', { name: 'Message input' }).fill('Answer locally.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();

  await expect(region.getByText(FINAL_TEXT).first()).toBeVisible({ timeout: 90_000 });
  const statusTexts = await page.evaluate(
    () => (window as unknown as { localModelStatusTexts: string[] }).localModelStatusTexts
  );
  expect(statusTexts).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/Loading model files.*50%/u),
      expect.stringContaining('Model loaded'),
    ])
  );
  expect(modelProvider.requestCount()).toBe(0);
  expect(modelProvider.refusals()).toEqual([]);
});
