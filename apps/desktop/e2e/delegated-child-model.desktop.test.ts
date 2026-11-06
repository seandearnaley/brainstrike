// ADR-0037: a pinned persona's subagent runs on its own model, at its own effort.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
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

test("a pinned persona's subagent runs on its pinned model at its effort", async ({
  electron,
}, testInfo) => {
  test.setTimeout(180_000);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-child-model-'));
  const agents = path.join(workspace, '.brainstrike', 'agents');
  await mkdir(agents, { recursive: true });
  await writeFile(
    path.join(agents, 'opus-reviewer.md'),
    `---\nname: Opus Reviewer\ndescription: Reviews a request on Claude.\nmodel: openrouter::${CHILD}\neffort: high\n---\nReview the request and answer it.`
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
        arguments: { _background: { enabled: false }, prompt: TASK },
        name: 'agent-opus-reviewer',
      },
    };
  });
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
      await ensureAssistantShellVisible(window);
      const root = window.getByRole('region', { exact: true, name: 'Assistant' });
      // The workspace's personas load once the person trusts the folder (ADR-0032).
      await trustWorkspaceFromComposer(root);
      await root.getByRole('textbox', { name: 'Message input' }).fill('Ask the Opus reviewer.');
      await root.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(root.getByText(DONE, { exact: true })).toBeVisible({ timeout: 90_000 });

      // The child's request went to its pinned model with its pinned effort.
      const childRequests = provider.requests().filter((request) => asks(request, TASK));
      expect(childRequests.map(modelOf)).toEqual([CHILD]);
      expect(childRequests[0]?.requestBody).toMatchObject({ reasoning: { effort: 'high' } });

      // The child thread commits its own model, so its follow-ups run on it.
      const child = (await readHostThreadTree(electron.getUserDataDir())).find(
        ({ parentThreadId }) => parentThreadId !== undefined
      );
      const started = child?.rows.find(({ event }) => event.type === 'run.started')?.event;
      expect(started && 'modelId' in started ? started.modelId : undefined).toBe(
        `openrouter::${CHILD}`
      );
    },
    workspace,
  });
});
