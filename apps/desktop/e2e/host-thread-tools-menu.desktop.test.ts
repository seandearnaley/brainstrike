import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readCommittedRuns } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import type { ModelProviderScriptSelector } from './utils/model-provider-shim';

const API_KEY = 'test-key-host-tools-menu';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL_ID = 'anthropic/claude-sonnet-4.6';
const REPLIES = ['The first reply.', 'The second reply.', 'The third reply.'] as const;
// Hosted discovery defers the toggled tool, so each run reaches it through discovery.
const TOGGLED_TOOL = 'brainstrike_manageTaskList';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL_ID}`,
    provider: 'openrouter',
  });
  await enableAssistantCatalogModel(page, `openrouter::${MODEL_ID}`);
}

/** Each run lists the toggled tool's catalog entry, then asks load_tool for it. */
function discoveryScript(finalText: string): ModelProviderScriptSelector {
  return ({ requestBody }) =>
    (requestBody as { stream?: unknown }).stream === true
      ? {
          finalText,
          toolCallStages: [
            [{ arguments: { prefix: TOGGLED_TOOL }, name: 'list_available_tools' }],
            [{ arguments: { toolName: TOGGLED_TOOL }, name: 'load_tool' }],
          ],
        }
      : { finalText: 'Tools menu' };
}

/** Switch the toggled tool in the composer's Tools section and confirm the count. */
async function setToolEnabled(page: Page, region: Locator, enabled: boolean): Promise<void> {
  await region.getByRole('button', { name: 'Open assistant controls' }).click();
  const tools = page.getByRole('region', { name: 'AI Tools' });
  // "N of N enabled" holds exactly while every tool is on.
  const allEnabled = /(\d+) of \1 enabled/u;
  const expectAll = async (all: boolean): Promise<void> => {
    await (all
      ? expect(tools).toContainText(allEnabled)
      : expect(tools).not.toContainText(allEnabled));
  };
  await expectAll(!enabled);
  await tools.getByRole('searchbox', { name: 'Search tools' }).fill('task list');
  const toggle = tools.getByRole('switch', { name: 'Manage Task List enabled' });
  await expect(toggle).toBeChecked({ checked: !enabled });
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: enabled });
  await expectAll(enabled);
  await page.keyboard.press('Escape');
}

test("a host thread's Tools menu toggles a native tool, and the next host run leaves it out", async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  await enableModel(page);
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  // Run requests stream; the thread title request does not and offers no tools.
  const runRequests = () =>
    modelProvider
      .requests()
      .filter(({ requestBody }) => (requestBody as { stream?: unknown }).stream === true);
  const send = async (turn: number): Promise<void> => {
    modelProvider.setScript(discoveryScript(REPLIES[turn] ?? ''));
    await input.fill(`Turn ${turn + 1}.`);
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(region.getByText(REPLIES[turn] ?? '')).toBeVisible({ timeout: 90_000 });
    // Three model calls: the listing, the load, and the reply.
    expect(runRequests()).toHaveLength((turn + 1) * 3);
  };
  /** What discovery answered in the turn's committed run, and what its final call offered. */
  const discovered = async (turn: number) => {
    const tabId =
      (await page
        .getByRole('tablist', { name: 'Open assistant threads' })
        .getByRole('tab', { selected: true })
        .getAttribute('id')) ?? '';
    const run = (
      await readCommittedRuns(electron.getUserDataDir(), tabId.replace('assistant-thread-tab-', ''))
    )[turn];
    expect(run?.status).toBe('completed');
    expect(run?.results).toHaveLength(2);
    const listing = run?.results[0]?.output as
      | { readonly tools?: readonly { readonly name: string }[] }
      | undefined;
    const load = run?.results[1]?.output as { readonly success?: boolean } | undefined;
    return {
      listed: (listing?.tools ?? []).map(({ name }) => name),
      loaded: load?.success,
      requests: runRequests().slice(turn * 3, turn * 3 + 3),
    };
  };

  // Every tool enabled: the toggled tool is listed, loads, and reaches the model.
  await send(0);
  const first = await discovered(0);
  expect(first.listed).toEqual([TOGGLED_TOOL]);
  expect(first.loaded).toBe(true);
  expect(first.requests[0]?.toolNames).toEqual(
    expect.arrayContaining(['list_available_tools', 'load_tool'])
  );
  expect(first.requests[0]?.toolNames).not.toContain(TOGGLED_TOOL);
  expect(first.requests[2]?.toolNames).toContain(TOGGLED_TOOL);

  // The saved preference is what the next send captures for the host run.
  await setToolEnabled(page, region, false);
  await send(1);
  const second = await discovered(1);
  expect(second.listed).toEqual([]);
  expect(second.loaded).toBe(false);
  for (const request of second.requests) {
    expect(request.toolNames).toEqual(expect.arrayContaining(['load_tool']));
    expect(request.toolNames).not.toContain(TOGGLED_TOOL);
  }

  // Enabled again, the tool loads again.
  await setToolEnabled(page, region, true);
  await send(2);
  const third = await discovered(2);
  expect(third.listed).toEqual([TOGGLED_TOOL]);
  expect(third.loaded).toBe(true);
  expect(third.requests[2]?.toolNames).toContain(TOGGLED_TOOL);
  expect(modelProvider.refusals()).toEqual([]);
});
