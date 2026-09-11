import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestInfo } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { ElectronHarness } from './fixtures/electron-harness';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

type ChildDecisionScenario =
  | { decision: 'answer'; tool: 'askUser' }
  | { decision: 'approved' | 'rejected'; tool: 'submitPlan' };

// Literal entry points let the CI lane guard discover every scenario.
test('answers a reloaded delegated child question @smoke', async ({ electron }, testInfo) => {
  await assertChildDecision(electron, testInfo, { decision: 'answer', tool: 'askUser' });
});
test('approves a reloaded delegated child plan @smoke', async ({ electron }, testInfo) => {
  await assertChildDecision(electron, testInfo, { decision: 'approved', tool: 'submitPlan' });
});
test('rejects a reloaded delegated child plan @smoke', async ({ electron }, testInfo) => {
  await assertChildDecision(electron, testInfo, { decision: 'rejected', tool: 'submitPlan' });
});

// Only model transport is scripted. Workspace persona discovery, the assistant
// host, native suspension, persistence and shared workspace controls stay real.
async function assertChildDecision(
  electron: ElectronHarness,
  testInfo: TestInfo,
  scenario: ChildDecisionScenario
): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-child-interactive-'));
  const personaDirectory = path.join(workspace, '.brainstrike', 'agents');
  await mkdir(personaDirectory, { recursive: true });
  await writeFile(
    path.join(personaDirectory, 'decision-probe.md'),
    `---\nname: Decision Probe\ndescription: Requests an exact user decision.\ntools:\n  - ${scenario.tool}\n---\nAsk the user for the requested decision and report the result.`
  );
  const answer = 'CHILD_EXACT_ANSWER_1720';
  const feedback = 'CHILD_EXACT_REJECTION_1720';
  const childResult = `CHILD_${scenario.decision.toUpperCase()}_COMPLETE_1720`;
  const parentResult = `PARENT_${scenario.decision.toUpperCase()}_COMPLETE_1720`;
  const observed = { childDecision: false, parentResult: false };
  const parentCatalogs: string[][] = [];
  const provider = await startModelProviderShim(({ toolNames, messages }) => {
    const history = JSON.stringify(messages);
    const isParent = toolNames.includes('agent-decision-probe');
    if (isParent) {
      parentCatalogs.push([...toolNames].sort());
      observed.parentResult ||= history.includes(childResult);
      return {
        finalText: parentResult,
        toolCall: {
          arguments: { prompt: 'Request my decision, then report the exact outcome.' },
          name: 'agent-decision-probe',
        },
      };
    }
    // Match tool result content, not the scripted final response: the model
    // must receive the actual resumed decision through the native tool path.
    observed.childDecision ||=
      scenario.decision === 'answer'
        ? history.includes(answer)
        : history.includes(`\\"status\\":\\"${scenario.decision}\\"`) ||
          history.includes(`"status":"${scenario.decision}"`);
    if (scenario.decision === 'rejected') {
      observed.childDecision &&= history.includes(feedback);
    }
    return {
      finalText: childResult,
      toolCall: {
        arguments:
          scenario.tool === 'askUser'
            ? { question: 'Which exact marker should this child report?' }
            : {
                overview: 'Request a decision without modifying the workspace.',
                steps: [{ title: 'Report the exact user decision to the parent.' }],
                title: 'Child decision plan',
              },
        name: `brainstrike_${scenario.tool}`,
      },
    };
  });
  const environment = {
    BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
    BRAINSTRIKE_OPENROUTER_API_KEY: 'isolated-child-interactive-key',
    OPENROUTER_BASE_URL: provider.baseUrl,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  try {
    const window = await electron.ensureWindow();
    try {
      await ensureMockWorkspaceOpen(window);
      await configureAssistantProvider(window, {
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await new HomePage(window).openSettings();
      await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
      await window
        .getByRole('combobox', { exact: true, name: 'Read permission' })
        .selectOption('allow');
      await ensureAssistantShellVisible(window);
      const root = window.getByTestId('chat-panel');
      await root
        .getByRole('textbox', { name: 'Message input' })
        .fill('Delegate to Decision Probe to request my decision.');
      await root.getByRole('button', { exact: true, name: 'Send' }).click();
      const noticeId =
        scenario.tool === 'askUser' ? 'assistant-ask-user-notice' : 'assistant-submit-plan-notice';
      await expect(root.getByTestId(noticeId)).toBeVisible();
      await root.getByRole('button', { exact: true, name: 'Expand activity' }).click();
      await root.getByRole('button', { name: /Open .* conversation/ }).click();
      const childTab = window
        .getByRole('tablist', { name: 'Workspace tabs' })
        .getByRole('tab', { selected: true });
      await expect(childTab).toHaveText(/^(Cedar|Fern|Aspen|Maple|Iris|Willow)-[a-f0-9]+$/);
      const childName = (await childTab.innerText()).trim();
      const child = window.getByRole('region', { exact: true, name: childName });
      await expect(child.getByTestId(noticeId)).toBeVisible();
      const pausedRequests = provider.requestCount();
      await window.reload();
      await configureAssistantProvider(window, {
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await ensureAssistantShellVisible(window);
      const notice = child.getByTestId(noticeId);
      await expect(notice).toBeVisible();
      expect(provider.requestCount()).toBe(pausedRequests);
      if (scenario.decision === 'answer') {
        await notice.getByRole('textbox', { name: 'Your answer' }).fill(answer);
        await notice.getByRole('button', { exact: true, name: 'Send' }).click();
      } else {
        if (scenario.decision === 'rejected') {
          await notice.getByRole('textbox', { name: 'Feedback for the plan' }).fill(feedback);
        }
        await notice
          .getByRole('button', {
            exact: true,
            name: scenario.decision === 'approved' ? 'Approve' : 'Reject',
          })
          .click();
      }
      await expect(child.getByText(childResult, { exact: true })).toBeVisible();
      await expect(root.getByText(parentResult, { exact: true })).toBeVisible();
      expect(observed).toEqual({ childDecision: true, parentResult: true });
      expect(provider.requestCount()).toBe(pausedRequests + 2);
      expect(parentCatalogs).toHaveLength(2);
      expect(parentCatalogs[1]).toEqual(parentCatalogs[0]);
      const completedRequests = provider.requestCount();
      await window.getByRole('button', { exact: true, name: `Close ${childName}` }).click();
      await expect(root.getByText(parentResult, { exact: true })).toBeVisible();
      expect(provider.requestCount()).toBe(completedRequests);
      await window.screenshot({
        animations: 'disabled',
        path: testInfo.outputPath('child-decision.png'),
      });
    } catch (error) {
      await testInfo.attach('interactive-child-failure', {
        body: await window.locator('body').innerText(),
        contentType: 'text/plain',
      });
      throw error;
    }
  } finally {
    await electron.dispose();
    await provider.close();
    for (const key of Object.keys(environment)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(workspace, { force: true, recursive: true });
  }
}
