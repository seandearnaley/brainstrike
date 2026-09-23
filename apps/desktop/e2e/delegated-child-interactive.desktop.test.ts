// Keep foreground decisions covered explicitly; delegated-worker-write covers background mode.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestInfo } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { ElectronHarness } from './fixtures/electron-harness';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { runInteractiveChildFixture } from './utils/interactive-child-fixture';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';
import {
  assembledMarkers,
  captureAssistantNetwork,
  createAssembledSubagentFixture,
  readAssembledPersistence,
} from './utils/subagent-integration-fixture';

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

test('assembles concurrent child control, reload, and durable results @smoke', async ({
  electron,
}, testInfo) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-assembled-subagents-'));
  const fixture = await createAssembledSubagentFixture(workspace);
  let assistantNetwork: ReturnType<typeof captureAssistantNetwork> = () => [];
  await runInteractiveChildFixture({
    captureFailure: async (window) => {
      const activityDiagnostics = {
        activityCount: await window.getByTestId('assistant-activity-group').count(),
        buttons: await window
          .getByTestId('chat-panel')
          .getByRole('button')
          .evaluateAll((buttons) =>
            buttons.map((button) => ({
              expanded: button.getAttribute('aria-expanded'),
              name: button.getAttribute('aria-label') ?? button.textContent,
            }))
          ),
        persistence: await readAssembledPersistence(window),
      };
      console.error('ASSEMBLED_ACTIVITY_DIAGNOSTICS', JSON.stringify(activityDiagnostics));
      await testInfo.attach('assembled-subagent-failure', {
        body: await window.locator('body').innerText(),
        contentType: 'text/plain',
      });
      await testInfo.attach('assembled-activity-diagnostics', {
        body: JSON.stringify(activityDiagnostics, null, 2),
        contentType: 'application/json',
      });
      await testInfo.attach('assembled-provider-transcript', {
        body: JSON.stringify(fixture.provider.transcript(), null, 2),
        contentType: 'application/json',
      });
      await testInfo.attach('assembled-assistant-network', {
        body: JSON.stringify(assistantNetwork(), null, 2),
        contentType: 'application/json',
      });
    },
    closeProvider: async () => {
      fixture.releaseAlpha();
      fixture.releaseBeta();
      await fixture.provider.close();
    },
    electron,
    environment: fixture.environment,
    run: async (window) => {
      assistantNetwork = captureAssistantNetwork(window);
      await ensureMockWorkspaceOpen(window);
      await configureAssistantProvider(window, {
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await new HomePage(window).openSettings();
      const settings = new SettingsPage(window);
      await settings.openCategory(/Permissions/i, 'permissions');
      await window
        .getByRole('combobox', { exact: true, name: 'Read permission' })
        .selectOption('ask');
      // The scenario holds BOTH work permits below ("two work permits"): pin it.
      await settings.setSubagentLimit('Subagent work at once', 2);
      await ensureAssistantShellVisible(window);
      const root = window.getByTestId('chat-panel');
      const composer = root.getByRole('textbox', { name: 'Message input' });
      await composer.fill(assembledMarkers.parentPrompt);
      await root.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(root.getByText('ASSEMBLED_ROOT_CONTINUES_1770', { exact: true })).toBeVisible();

      const activity = root.getByTestId('assistant-activity-group').last();
      await activity.getByRole('button', { exact: true, name: 'Expand activity' }).click();
      const openChild = async (index: number) => {
        await activity
          .getByRole('button', { name: /Open .* conversation/ })
          .nth(index)
          .click();
        const heading = window
          .getByRole('heading', {
            name: /^(Cedar|Fern|Aspen|Maple|Iris|Willow)-[a-f0-9]+$/u,
          })
          .last();
        const name = (await heading.innerText()).trim();
        return {
          close: window.getByRole('button', {
            name: /^Close (Cedar|Fern|Aspen|Maple|Iris|Willow)-/,
          }),
          panel: window.getByRole('region', { exact: true, name }),
        };
      };

      const granted = await openChild(0);
      const childSessionGrant = granted.panel.getByTestId('approval-grant-category-session');
      await expect(childSessionGrant).toBeVisible();
      const concurrent = await readAssembledPersistence(window);
      expect(concurrent.children).toHaveLength(4);
      expect(concurrent.children.every((child) => child.invocationCount === 1)).toBe(true);
      expect(concurrent.children.filter((child) => child.taskStatus === 'suspended')).toHaveLength(
        2
      );
      expect(concurrent.children.filter((child) => child.taskStatus === 'running')).toHaveLength(2);
      await childSessionGrant.click();
      // Both held model responses own the two work permits. The grant resumes
      // the parked tasks, but their tools cannot run until selected Stop frees one.
      await expect
        .poll(
          async () =>
            (await readAssembledPersistence(window)).children.filter(
              (child) => child.taskStatus === 'running'
            ).length
        )
        .toBe(4);
      expect((await readAssembledPersistence(window)).workspaceReadCompletions).toBe(0);
      await granted.close.click();

      await composer.fill('UNSENT_ASSEMBLED_ROOT_DRAFT_1770');
      const stopped = await openChild(2);
      await expect(stopped.panel.getByRole('button', { exact: true, name: 'Stop' })).toBeVisible();
      await stopped.panel.getByRole('button', { exact: true, name: 'Stop' }).click();
      await expect
        .poll(
          async () =>
            (await readAssembledPersistence(window)).children.filter(
              (child) => child.taskStatus === 'cancelled'
            ).length
        )
        .toBe(1);
      await expect
        .poll(
          async () =>
            (await readAssembledPersistence(window)).children.filter(
              (child) => child.taskStatus === 'completed'
            ).length
        )
        .toBe(2);
      const afterStop = await readAssembledPersistence(window);
      expect(
        afterStop.children.find((child) => child.taskPrompt === 'STREAM_BETA_TASK_1770')?.taskStatus
      ).toBe('running');
      await stopped.close.click();
      await expect(composer).toHaveValue('UNSENT_ASSEMBLED_ROOT_DRAFT_1770');

      const beforeReload = fixture.provider.requestCount();
      await window.reload();
      await configureAssistantProvider(window, {
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await ensureAssistantShellVisible(window);
      await expect.soft(composer).toHaveValue('UNSENT_ASSEMBLED_ROOT_DRAFT_1770');
      expect(fixture.provider.requestCount()).toBe(beforeReload);

      const afterReload = await readAssembledPersistence(window);
      expect(afterReload.latestHostStatus).toBe('running');
      expect(
        afterReload.children.find((child) => child.taskPrompt === 'STREAM_BETA_TASK_1770')?.status
      ).toBe('running');
      fixture.releaseBeta();
      await expect(root.getByText(assembledMarkers.parentResult, { exact: true })).toBeVisible();
      await activity.getByRole('button', { exact: true, name: 'Expand activity' }).click();
      const survivor = await openChild(3);
      await expect(
        survivor.panel.getByText(assembledMarkers.streamB, { exact: true })
      ).toBeVisible();
      await survivor.close.click();

      await expect
        .poll(async () => (await readAssembledPersistence(window)).children.length)
        .toBe(4);
      const persisted = await readAssembledPersistence(window);
      expect(persisted.parentMessageCount).toBeGreaterThanOrEqual(2);
      expect(
        persisted.children
          .filter((child) => child.status === 'completed')
          .every((child) => child.messageCount >= 2)
      ).toBe(true);
      expect(persisted.children.filter((child) => child.status === 'cancelled')).toHaveLength(1);
      expect(persisted.children.filter((child) => child.status === 'completed')).toHaveLength(3);
      expect(
        persisted.children
          .filter((child) => child.status === 'completed')
          .every((child) => child.usageRows >= 1)
      ).toBe(true);
      expect(persisted.children.every((child) => child.invocationCount === 1)).toBe(true);
      expect(new Set(persisted.children.map((child) => child.invocationId)).size).toBe(4);
      expect(persisted.children.every((child) => child.invocationMatchesTask)).toBe(true);
      expect(persisted.children.filter((child) => child.taskStatus === 'completed')).toHaveLength(
        3
      );
      expect(persisted.children.filter((child) => child.taskStatus === 'cancelled')).toHaveLength(
        1
      );
      expect(persisted.generationRunIds).toEqual([persisted.latestHostGenerationRunId]);
      expect(persisted.latestHostRunId).not.toBe('missing');
      expect(persisted.nativeRunCount).toBeGreaterThanOrEqual(1);
      expect(persisted.parentResultSlots).toHaveLength(4);
      expect(new Set(persisted.parentResultSlots.map((slot) => slot.toolCallId))).toEqual(
        new Set(persisted.children.map((child) => child.parentToolCallId))
      );
      const resultMarkerByPrompt = new Map([
        ['PARKED_GRANT_TASK_1770', assembledMarkers.parkedApproved],
        ['PARKED_STOP_TASK_1770', 'PARKED_STOP_SURVIVOR_COMPLETE_1770'],
        ['STREAM_ALPHA_TASK_1770', assembledMarkers.streamA],
        ['STREAM_BETA_TASK_1770', assembledMarkers.streamB],
      ]);
      for (const child of persisted.children.filter((entry) => entry.taskStatus === 'completed')) {
        const marker = resultMarkerByPrompt.get(child.taskPrompt);
        expect(marker).toBeDefined();
        expect(JSON.stringify(child.taskResult)).toContain(marker);
        const slot = persisted.parentResultSlots.find(
          (candidate) => candidate.toolCallId === child.parentToolCallId
        );
        expect(slot).toBeDefined();
        const snapshots = slot?.snapshots ?? [];
        expect(
          snapshots.every(
            (snapshot) =>
              (snapshot.state === 'call' && snapshot.result === null) ||
              (snapshot.state === 'result' &&
                snapshot.errorText === null &&
                (JSON.stringify(snapshot.result).includes('Background task started.') ||
                  JSON.stringify(snapshot.result) === JSON.stringify(child.taskResult)))
          )
        ).toBe(true);
        expect(snapshots.at(-1)?.state).toBe('result');
        expect(snapshots.at(-1)?.result).toEqual(child.taskResult);
      }
      expect(persisted.terminalEvents).toEqual(
        persisted.children
          .map((child) => ({
            kind: child.taskStatus === 'cancelled' ? 'run.cancelled' : 'run.finished',
            toolCallId: child.parentToolCallId,
          }))
          .sort((a, b) => a.toolCallId.localeCompare(b.toolCallId))
      );
      const cancelled = persisted.children.find((child) => child.taskStatus === 'cancelled');
      expect(cancelled).toBeDefined();
      expect(cancelled?.taskResult).toBeNull();
      // Abort persistence retains the user input and an assistant abort marker,
      // but no provider usage or unfinished workspace tool execution.
      expect(cancelled?.messageCount).toBe(2);
      expect(cancelled?.hasAbortMarker).toBe(true);
      expect(cancelled?.usageRows).toBe(0);
      const cancelledSlot = persisted.parentResultSlots.find(
        (slot) => slot.toolCallId === cancelled?.parentToolCallId
      );
      expect(cancelledSlot).toBeDefined();
      expect(
        cancelledSlot?.snapshots.every(
          (snapshot) =>
            (snapshot.state === 'call' && snapshot.result === null) ||
            (snapshot.state === 'result' &&
              JSON.stringify(snapshot.result).includes('Background task started.')) ||
            (snapshot.state === 'output-error' && typeof snapshot.errorText === 'string')
        )
      ).toBe(true);
      expect(cancelledSlot?.snapshots.at(-1)?.state).toBe('output-error');
      expect(cancelledSlot?.snapshots.at(-1)?.result).toBeNull();
      expect(cancelledSlot?.snapshots.at(-1)?.errorText).toEqual(expect.any(String));
      // Alpha is stopped before the shim emits tool_calls finish; only the
      // three survivors may execute the workspace read.
      expect(persisted.workspaceReadCompletions).toBe(3);

      // Title requests quote the root user prompt too, but have no tool catalog.
      const parentRequests = fixture
        .requests()
        .filter((request) => request.toolNames.includes('agent-stream-alpha'));
      const finalParentInput = JSON.stringify(parentRequests.at(-1)?.messages);
      expect(finalParentInput).toContain(assembledMarkers.streamB);
      expect(finalParentInput).toContain(assembledMarkers.parkedApproved);
      expect(finalParentInput).toContain('PARKED_STOP_SURVIVOR_COMPLETE_1770');
      expect(finalParentInput).not.toContain('ASSEMBLED_EVIDENCE_1770');

      const completedRequests = fixture.provider.requestCount();
      await window.reload();
      await ensureAssistantShellVisible(window);
      await expect(root.getByText(assembledMarkers.parentResult, { exact: true })).toBeVisible();
      expect(await readAssembledPersistence(window)).toEqual(persisted);
      expect(fixture.provider.requestCount()).toBe(completedRequests);
    },
    workspace,
  });
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
    const isParent = JSON.stringify(
      messages
        .filter(
          (message) =>
            message && typeof message === 'object' && 'role' in message && message.role === 'user'
        )
        .at(-1)
    ).includes('Delegate to Decision Probe to request my decision.');
    if (isParent) {
      parentCatalogs.push([...toolNames].sort());
      observed.parentResult ||= history.includes(childResult);
      return {
        finalText: parentResult,
        toolCall: {
          arguments: {
            _background: { enabled: false },
            prompt: 'Request my decision, then report the exact outcome.',
          },
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
  await runInteractiveChildFixture({
    captureFailure: async (window) => {
      await testInfo.attach('interactive-child-failure', {
        body: await window.locator('body').innerText(),
        contentType: 'text/plain',
      });
    },
    closeProvider: () => provider.close(),
    electron,
    environment,
    run: async (window) => {
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
    },
    workspace,
  });
}
