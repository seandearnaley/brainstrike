// ADR-0037: a subagent runs on the model its persona pins or its delegation names, at its effort.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { ElectronHarness } from './fixtures/electron-harness';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { runInteractiveChildFixture } from './utils/interactive-child-fixture';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { type ModelProviderRequest, startModelProviderShim } from './utils/model-provider-shim';
import { trustWorkspaceFromComposer } from './utils/workspace-trust';

const PARENT = 'openai/gpt-5.4';
const CHILD = 'anthropic/claude-opus-5.5';
const TASK = 'CHILD_MODEL_TASK_0037';
const ANSWER = 'CHILD_MODEL_ANSWER_0037';
const DONE = 'ROOT_DONE_0037';

const modelOf = (request: ModelProviderRequest): unknown =>
  (request.requestBody as { model?: unknown }).model;

/** Whether the request's own user turn is `text`, as a delegated child's first request is. */
const asks = (request: ModelProviderRequest, text: string): boolean =>
  request.messages.some(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'role' in message &&
      message.role === 'user' &&
      'content' in message &&
      JSON.stringify(message.content).includes(text)
  );

interface Scenario {
  /** The persona file's frontmatter beside its name and description. */
  readonly frontmatter: string;
  /** What the parent's model passes to the delegation beside its task. */
  readonly input: Record<string, unknown>;
  /** Settings the person changes before sending. */
  readonly prepare?: (window: Page) => Promise<void>;
}

/**
 * The root on GPT-5.4 delegates `TASK` to a trusted workspace persona over an
 * OpenRouter shim; it returns the child's first request once the root is done.
 */
async function delegate(
  electron: ElectronHarness,
  testInfo: TestInfo,
  scenario: Scenario
): Promise<{ readonly child: ModelProviderRequest | undefined; readonly modelId: unknown }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-child-model-'));
  const agents = path.join(workspace, '.brainstrike', 'agents');
  await mkdir(agents, { recursive: true });
  await writeFile(
    path.join(agents, 'reviewer.md'),
    `---\nname: Reviewer\ndescription: Reviews a request.\n${scenario.frontmatter}---\nReview the request and answer it.`
  );
  const provider = await startModelProviderShim((request) => {
    if (request.toolNames.length === 0) {
      return { finalText: 'Child model check' };
    }
    if (modelOf(request) === CHILD) {
      return { finalText: ANSWER };
    }
    if (JSON.stringify(request.messages).includes(ANSWER)) {
      return { finalText: DONE };
    }
    return {
      finalText: DONE,
      toolCall: {
        arguments: { _background: { enabled: false }, prompt: TASK, ...scenario.input },
        name: 'agent-reviewer',
      },
    };
  });
  let result: { child: ModelProviderRequest | undefined; modelId: unknown } = {
    child: undefined,
    modelId: undefined,
  };
  await runInteractiveChildFixture({
    captureFailure: async (window) => {
      await testInfo.attach('child-model-failure', {
        body: await window.locator('body').innerText(),
        contentType: 'text/plain',
      });
    },
    closeProvider: () => provider.close(),
    electron,
    environment: {
      ['BRAINSTRIKE_E2E_REAL_ROOT_PATH']: workspace,
      ['BRAINSTRIKE_OPENROUTER_API_KEY']: 'child-model-fixture-key',
      ['OPENROUTER_BASE_URL']: provider.baseUrl,
    },
    run: async (window) => {
      await ensureMockWorkspaceOpen(window);
      await configureAssistantProvider(window, {
        compositeModelKey: `openrouter::${PARENT}`,
        provider: 'openrouter',
      });
      await enableAssistantCatalogModel(window, `openrouter::${PARENT}`);
      await enableAssistantCatalogModel(window, `openrouter::${CHILD}`);
      await scenario.prepare?.(window);
      await ensureAssistantShellVisible(window);
      const root = window.getByRole('region', { exact: true, name: 'Assistant' });
      // The workspace's personas load once the person trusts the folder (ADR-0032).
      await trustWorkspaceFromComposer(root);
      await root.getByRole('textbox', { name: 'Message input' }).fill('Ask the reviewer.');
      await root.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(root.getByText(DONE, { exact: true })).toBeVisible({ timeout: 90_000 });
      const child = (await readHostThreadTree(electron.getUserDataDir())).find(
        ({ parentThreadId }) => parentThreadId !== undefined
      );
      const started = child?.rows.find(({ event }) => event.type === 'run.started')?.event;
      result = {
        child: provider.requests().find((request) => asks(request, TASK)),
        modelId: started && 'modelId' in started ? started.modelId : undefined,
      };
    },
    workspace,
  });
  return result;
}

test("a pinned persona's subagent runs on its pinned model at its effort", async ({
  electron,
}, testInfo) => {
  test.setTimeout(180_000);
  const { child, modelId } = await delegate(electron, testInfo, {
    frontmatter: `model: openrouter::${CHILD}\neffort: high\n`,
    input: {},
  });
  // The child's request went to its pinned model with its pinned effort, and
  // its thread commits that model, so its follow-ups run on it.
  expect(modelOf(child as ModelProviderRequest)).toBe(CHILD);
  expect(child?.requestBody).toMatchObject({ reasoning: { effort: 'high' } });
  expect(modelId).toBe(`openrouter::${CHILD}`);
});

test('a delegation runs its subagent on a model the person allowed, at the effort it names', async ({
  electron,
}, testInfo) => {
  test.setTimeout(180_000);
  const { child, modelId } = await delegate(electron, testInfo, {
    frontmatter: '',
    input: { effort: 'low', model: `openrouter::${CHILD}` },
    prepare: async (window) => {
      await new HomePage(window).openSettings();
      const settings = await new SettingsPage(window).openCategory(/Subagents/iu, 'subagents');
      const models = settings.getByTestId('subagent-models-section');
      await models.getByRole('button', { name: 'Add model' }).click();
      await window
        .getByRole('dialog', { name: 'Add a model subagents may run on' })
        .getByRole('option', { name: /Claude Opus 5\.5 \(OpenRouter\)/u })
        .click();
      await expect(models.getByRole('list')).toContainText('Claude Opus 5.5');
      await new HomePage(window).leaveSettings();
    },
  });
  expect(modelOf(child as ModelProviderRequest)).toBe(CHILD);
  expect(child?.requestBody).toMatchObject({ reasoning: { effort: 'low' } });
  expect(modelId).toBe(`openrouter::${CHILD}`);
});
