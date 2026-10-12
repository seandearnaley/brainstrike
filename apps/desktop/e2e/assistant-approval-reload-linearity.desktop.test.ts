import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import {
  readHostRoot,
  readHostThreadTree,
  readSpooledBlobHashes,
  withAppHost,
} from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { runInteractiveChildFixture } from './utils/interactive-child-fixture';
import {
  ensureActivityExpanded,
  ensureAssistantShellVisible,
  ensureMockWorkspaceOpen,
} from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { type ModelProviderRequest, startModelProviderShim } from './utils/model-provider-shim';
import { E2E_TIMEOUTS } from './utils/timeouts';

/**
 * BST-1243: a linear conversation containing a suspend decision must stay
 * linear, live and across a reload. On a host thread the message graph is the
 * host log's own: each user run names the committed message it follows
 * (`run.started.parentMessageId`), and an answered question resumes its run
 * rather than starting another.
 */

const FIRST_PROMPT = 'Ask me which package index to inspect.';
const QUESTION_ANSWER = 'PYPI_INDEX_ANSWER_1243';
const RESUMED_REPLY = 'Question decision resumed.';
const FOLLOW_UP_PROMPT = 'Now summarize what you found.';
const FOLLOW_UP_REPLY = 'Summary after the question decision.';
const LINEAR_TITLE = 'Approval linearity verification';
const DAMAGED_PROMPT = 'Reply at length about the damaged history.';
const HEALTHY_PROMPT = 'Reply briefly about the healthy history.';
const LONG_REPLY_MARKER = 'LONG_REPLY_1932';
/** One reply large enough that its committed rows spool into blobs. */
const LONG_REPLY = `${LONG_REPLY_MARKER} ${'A long recorded reply. '.repeat(1200)}`;

/** The text of the request's newest user message. */
function lastUserMessage({ messages }: ModelProviderRequest): string {
  return JSON.stringify(
    messages
      .filter(
        (message) =>
          message && typeof message === 'object' && 'role' in message && message.role === 'user'
      )
      .at(-1)
  );
}

/** Mocked workspace files for the cases that need no real workspace root. */
async function prepareMockWorkspace(window: Page): Promise<void> {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
}

/**
 * The only root thread's user runs as the host committed them: each one's
 * prompt, how it ended, and whether it follows the run before it (the first
 * follows the thread root), plus its question pauses and their answers.
 */
async function readLinearRoot(userDataDir: string) {
  const roots = (await readHostThreadTree(userDataDir)).filter(
    ({ parentThreadId }) => parentThreadId === undefined
  );
  if (roots.length !== 1) {
    throw new Error(`Expected one root thread, found ${roots.length}`);
  }
  const events = (roots[0]?.rows ?? []).map(({ event }) => event);
  const runs = events.flatMap((event) => (event.type === 'run.started' ? [event] : []));
  return {
    answers: events.filter(
      (event) => event.type === 'interaction.responded' && 'resumeData' in event
    ).length,
    questions: events.filter(
      (event) => event.type === 'interaction.requested' && event.kind === 'question'
    ).length,
    runs: runs.map((run, index) => ({
      followsPrevious:
        index === 0 ? run.parentMessageId === null : run.parentMessageId === runs[index - 1]?.runId,
      outcome:
        events.flatMap((event) =>
          event.type === 'run.finished' && event.runId === run.runId ? [event.outcome] : []
        )[0] ?? 'running',
      prompt: run.prompt,
    })),
  };
}

async function waitForAssistantChat(window: Page): Promise<void> {
  await expect(await ensureAssistantShellVisible(window)).toBeVisible({
    timeout: E2E_TIMEOUTS.cardVisibility,
  });
  const loadingIndicator = window.getByText(/Loading assistant/i);
  if (await loadingIndicator.isVisible().catch(() => false)) {
    await loadingIndicator.waitFor({
      state: 'hidden',
      timeout: E2E_TIMEOUTS.loadingIndicator,
    });
  }
  await expect(window.getByRole('region', { exact: true, name: 'Assistant' })).toBeVisible({
    timeout: E2E_TIMEOUTS.chatPanel,
  });
}

async function sendPrompt(window: Page, text: string): Promise<void> {
  const input = window.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill(text);
  await window.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(window.getByText(text).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
}

test.describe('approval-turn reload linearity (desktop, BST-1243)', () => {
  test('a suspend decision mid-thread keeps the host thread linear across a reload', async ({
    electron,
    modelProvider,
    window,
  }) => {
    await prepareMockWorkspace(window);
    await configureAssistantProvider(window);
    modelProvider.setScript((request) => {
      if (request.toolNames.length === 0) {
        return { finalText: LINEAR_TITLE };
      }
      if (lastUserMessage(request).includes(FOLLOW_UP_PROMPT)) {
        return { finalText: FOLLOW_UP_REPLY };
      }
      const askUser = request.toolNames.find((tool) => tool.endsWith('askUser'));
      return askUser
        ? {
            finalText: RESUMED_REPLY,
            toolCall: { arguments: { question: 'Which package index?' }, name: askUser },
          }
        : { finalText: `No askUser tool offered: ${request.toolNames.join(', ')}` };
    });
    // Agent turns advertise tools; the thread-title request has none.
    const modelCalls = (): number =>
      modelProvider.requests().filter(({ toolNames }) => toolNames.length > 0).length;
    await waitForAssistantChat(window);
    await sendPrompt(window, FIRST_PROMPT);
    const region = window.getByRole('region', { exact: true, name: 'Assistant' });
    const form = region.getByRole('group', { name: 'Question for you' });
    await expect(form).toBeVisible({ timeout: E2E_TIMEOUTS.toolVisibility });
    await form.getByRole('textbox', { name: 'Your answer' }).fill(QUESTION_ANSWER);
    await form.getByRole('button', { exact: true, name: 'Send answer' }).click();
    await expect(region.getByText(RESUMED_REPLY, { exact: true })).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });
    // The follow-up: the message whose parent the legacy bug chained onto a ghost.
    await sendPrompt(window, FOLLOW_UP_PROMPT);
    await expect(region.getByText(FOLLOW_UP_REPLY, { exact: true })).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });

    // Half 1: the host log is one chain. The answer resumed its own run.
    const linear = {
      answers: 1,
      questions: 1,
      runs: [
        { followsPrevious: true, outcome: 'completed', prompt: FIRST_PROMPT },
        { followsPrevious: true, outcome: 'completed', prompt: FOLLOW_UP_PROMPT },
      ],
    };
    await expect.poll(() => readLinearRoot(electron.getUserDataDir())).toEqual(linear);
    const completedCalls = modelCalls();

    // Half 2: the reloaded thread renders as one stream, with no branch carousel.
    await window.reload();
    await prepareMockWorkspace(window);
    await waitForAssistantChat(window);
    await window
      .getByRole('treegrid', { name: 'Workspace threads' })
      .getByRole('button')
      .filter({ has: window.getByText(LINEAR_TITLE, { exact: true }) })
      .click();
    for (const text of [FIRST_PROMPT, RESUMED_REPLY, FOLLOW_UP_PROMPT, FOLLOW_UP_REPLY]) {
      await expect(region.getByText(text, { exact: true }).first()).toBeVisible({
        timeout: E2E_TIMEOUTS.messageVisibility,
      });
    }
    await expect(window.getByLabel('Previous branch')).toHaveCount(0);
    await expect(window.getByLabel('Next branch')).toHaveCount(0);
    expect(await readLinearRoot(electron.getUserDataDir())).toEqual(linear);
    expect(modelCalls()).toBe(completedCalls);
  });

  // AT-12 case 2 on the blob-move seam: a thread whose spooled history cannot
  // be read stays listed with its read failure, opens to an alert instead of a
  // transcript, and leaves the other threads readable. Once its blob is back,
  // the next launch reads it whole again. Nothing calls the model.
  test('a damaged thread shows its read failure while the others list, then recovers with its blob', async ({
    electron,
    modelProvider,
    window,
  }) => {
    test.setTimeout(240_000);
    const damagedTitle = 'Damaged history verification';
    const healthyTitle = 'Healthy history verification';
    const healthyReply = 'HEALTHY_REPLY_1932';
    modelProvider.setScript((request) => {
      const damaged = lastUserMessage(request).includes(DAMAGED_PROMPT);
      if (request.toolNames.length === 0) {
        return { finalText: damaged ? damagedTitle : healthyTitle };
      }
      return { finalText: damaged ? LONG_REPLY : healthyReply };
    });
    const modelCalls = (): number => modelProvider.requests().length;
    let page = window;
    const open = async (): Promise<void> => {
      await prepareMockWorkspace(page);
      await configureAssistantProvider(page);
      await waitForAssistantChat(page);
    };
    await open();
    await sendPrompt(page, DAMAGED_PROMPT);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await expect(region.getByText(LONG_REPLY_MARKER).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });
    // Each thread keeps its panel mounted: send from the new thread's own panel.
    // Until the first thread's generated title commits, both tabs are named
    // "New Thread", so the panel is the one whose tab the click selected.
    const selectedThreadTab = page
      .getByRole('tab', { selected: true })
      .and(page.locator('[id^="assistant-thread-tab-"]'));
    const damagedTabId = await selectedThreadTab.getAttribute('id');
    if (!damagedTabId) {
      throw new Error('The damaged thread has no selected thread tab');
    }
    await page.getByTestId('assistant-new-thread-button').click();
    await expect(selectedThreadTab).not.toHaveId(damagedTabId);
    const healthyPanelId = await selectedThreadTab.getAttribute('aria-controls');
    if (!healthyPanelId) {
      throw new Error('The new thread tab controls no panel');
    }
    const healthyTabPanel = page
      .getByRole('tabpanel', { exact: true, name: 'New Thread' })
      .and(page.locator(`[id="${healthyPanelId}"]`));
    await expect(healthyTabPanel).toBeVisible();
    const healthyPanel = healthyTabPanel.getByRole('region', { exact: true, name: 'Assistant' });
    await healthyPanel.getByRole('textbox', { name: 'Message input' }).fill(HEALTHY_PROMPT);
    await healthyPanel.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(page.getByText(healthyReply, { exact: true }).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });
    const userDataDir = electron.getUserDataDir();
    // A row's open button may also announce unseen activity after its title.
    const threadRow = (title: string) =>
      page
        .getByTestId('thread-row')
        .getByRole('button', { name: new RegExp(`^${title}(?: has unseen activity)?$`, 'u') });
    await expect(threadRow(damagedTitle)).toBeVisible();
    await expect(threadRow(healthyTitle)).toBeVisible();
    const damagedThread = (await readHostThreadTree(userDataDir)).find(({ rows }) =>
      rows.some(({ event }) => event.type === 'run.started' && event.prompt === DAMAGED_PROMPT)
    );
    if (!damagedThread) {
      throw new Error('The host committed no thread for the damaged prompt');
    }
    const root = await readHostRoot(userDataDir);
    const blobs = readSpooledBlobHashes(root, damagedThread.threadId);
    expect(blobs.length).toBeGreaterThan(0);
    const settledCalls = modelCalls();

    // Move the thread's spooled blobs aside while no host owns the Root.
    const aside = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-moved-blobs-'));
    await electron.closeForStateSeeding();
    for (const hash of blobs) {
      await rename(path.join(root, 'blobs', hash), path.join(aside, hash));
    }
    page = await electron.ensureWindow();
    await open();
    // Its generated title is one of the rows the host cannot read, so the
    // damaged thread lists under the default title until its blob returns.
    const damagedListing = 'New Thread';
    const marker = page.getByTestId('thread-read-failure');
    await expect(marker).toHaveCount(1);
    await expect(marker).toHaveAccessibleName(
      new RegExp(`^${damagedListing}: its history cannot be read\\. `, 'u')
    );
    await expect(threadRow(damagedTitle)).toHaveCount(0);
    const { threads } = await withAppHost(userDataDir, (client) =>
      client.request('thread/list', {})
    );
    const damage = threads.find(({ threadId }) => threadId === damagedThread.threadId)?.damage;
    expect(damage).toMatch(/\S/u);
    await threadRow(damagedListing).click();
    // The thread's panel shows the host's own refusal in place of a conversation.
    const alert = page
      .getByRole('tabpanel', { exact: true, name: damagedListing })
      .getByRole('alert', { name: 'Agent host error' });
    await expect(alert).toHaveText(`This thread's history cannot be read: ${damage}`);
    await expect(page.getByText(LONG_REPLY_MARKER)).toHaveCount(0);
    await threadRow(healthyTitle).click();
    await expect(page.getByText(healthyReply, { exact: true }).first()).toBeVisible();
    expect(modelCalls()).toBe(settledCalls);

    // The blobs return; the next launch reads the thread whole.
    await electron.closeForStateSeeding();
    for (const hash of blobs) {
      await rename(path.join(aside, hash), path.join(root, 'blobs', hash));
    }
    page = await electron.ensureWindow();
    await open();
    await expect(page.getByTestId('thread-read-failure')).toHaveCount(0);
    await threadRow(damagedTitle).click();
    await expect(page.getByText(LONG_REPLY_MARKER).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });
    await expect(
      page
        .getByRole('tabpanel', { exact: true, name: damagedTitle })
        .getByRole('alert', { name: 'Agent host error' })
    ).toHaveCount(0);
    expect(modelCalls()).toBe(settledCalls);
  });

  // A decision in flight ("claimed") has no host form: `interaction/respond` is one
  // atomic command. An interrupted decision is AT-06's restart case.
  test('reload shows a delegated child’s answered approval and question locked, never resubmitted', async ({
    electron,
  }, testInfo) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-decision-states-'));
    const personas = path.join(workspace, '.brainstrike', 'agents');
    await mkdir(personas, { recursive: true });
    await writeFile(
      path.join(personas, 'decision-states.md'),
      '---\nname: Decision States\ndescription: Asks a question, then reads a file.\ntools:\n  - askUser\n  - readWorkspaceFile\n---\nAsk the user, then read evidence.txt and report.'
    );
    await writeFile(path.join(workspace, 'evidence.txt'), 'DECISION_EVIDENCE_1243');
    const parentPrompt = 'Delegate to Decision States to ask me and read the evidence.';
    const answer = 'DECISION_ANSWER_1243';
    const childResult = 'CHILD_DECISIONS_COMPLETE_1243';
    const parentResult = 'PARENT_DECISIONS_COMPLETE_1243';
    const provider = await startModelProviderShim((request) => {
      if (request.toolNames.length === 0) {
        return { finalText: 'Decision states' };
      }
      if (lastUserMessage(request).includes(parentPrompt)) {
        return {
          finalText: parentResult,
          toolCall: {
            arguments: {
              _background: { enabled: false },
              prompt: 'Ask the user, then read evidence.txt.',
            },
            name: 'agent-decision-states',
          },
        };
      }
      // One pause per step: the question first, then the read's approval.
      const history = JSON.stringify(request.messages);
      if (history.includes('DECISION_EVIDENCE_1243')) {
        return { finalText: childResult };
      }
      if (history.includes(answer)) {
        return {
          finalText: childResult,
          ignorePriorToolResults: true,
          toolCall: {
            arguments: { path: 'evidence.txt' },
            name: 'brainstrike_readWorkspaceFile',
          },
        };
      }
      return {
        finalText: childResult,
        toolCall: { arguments: { question: 'Which workspace?' }, name: 'brainstrike_askUser' },
      };
    });
    // Agent turns advertise tools; a thread-title request has none.
    const modelCalls = (): number =>
      provider.requests().filter(({ toolNames }) => toolNames.length > 0).length;
    await runInteractiveChildFixture({
      captureFailure: async (window) => {
        await testInfo.attach('decision-states-failure', {
          body: await window.locator('body').innerText(),
          contentType: 'text/plain',
        });
        await testInfo.attach('decision-states-host-tree', {
          body: JSON.stringify(
            await readHostThreadTree(electron.getUserDataDir()).catch((error: unknown) =>
              String(error)
            ),
            null,
            2
          ),
          contentType: 'application/json',
        });
      },
      closeProvider: () => provider.close(),
      electron,
      environment: {
        ['BRAINSTRIKE_E2E_REAL_ROOT_PATH']: workspace,
        ['BRAINSTRIKE_OPENROUTER_API_KEY']: 'isolated-decision-states-key',
        ['OPENROUTER_BASE_URL']: provider.baseUrl,
      },
      run: async (window) => {
        await ensureMockWorkspaceOpen(window);
        await configureAssistantProvider(window, {
          compositeModelKey: 'openrouter::openai/gpt-5.4',
          provider: 'openrouter',
        });
        await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
        await new HomePage(window).openSettings();
        await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
        await window
          .getByRole('combobox', { exact: true, name: 'Read permission' })
          .selectOption('ask');
        await ensureAssistantShellVisible(window);
        const root = window.getByRole('region', { exact: true, name: 'Assistant' });
        await root.getByRole('textbox', { name: 'Message input' }).fill(parentPrompt);
        await root.getByRole('button', { exact: true, name: 'Send' }).click();
        await expect(root.getByTestId('host-child-waiting')).toBeVisible();
        await ensureActivityExpanded(root);
        await root.getByRole('button', { name: /Open .* conversation/ }).click();
        const childTab = window
          .getByRole('tablist', { name: 'Workspace tabs' })
          .getByRole('tab', { selected: true });
        await expect(childTab).toHaveText(/^[A-Z][a-z]+-[a-f0-9]{6}$/u);
        const child = window.getByRole('region', {
          exact: true,
          name: (await childTab.innerText()).trim(),
        });
        const question = child.getByRole('group', { name: 'Question for you' });
        await question.getByRole('textbox', { name: 'Your answer' }).fill(answer);
        await question.getByRole('button', { exact: true, name: 'Send answer' }).click();
        const approve = child.getByRole('button', {
          exact: true,
          name: 'Approve brainstrike.readWorkspaceFile',
        });
        await approve.click();
        await expect(child.getByText(childResult, { exact: true })).toBeVisible();
        await expect(root.getByText(parentResult, { exact: true })).toBeVisible();
        const childDecisions = async () => {
          const childLog = (await readHostThreadTree(electron.getUserDataDir())).find(
            ({ parentThreadId }) => parentThreadId !== undefined
          );
          const events = (childLog?.rows ?? []).map(({ event }) => event);
          return events
            .flatMap((event) => (event.type === 'interaction.requested' ? [event] : []))
            .map(({ interactionId, kind }) => ({
              kind,
              responses: events.filter(
                (event) =>
                  event.type === 'interaction.responded' && event.interactionId === interactionId
              ).length,
            }));
        };
        // Each decision answered exactly once.
        const answered = [
          { kind: 'question', responses: 1 },
          { kind: 'approval', responses: 1 },
        ];
        await expect.poll(childDecisions).toEqual(answered);
        const completedCalls = modelCalls();

        await window.reload();
        await configureAssistantProvider(window, {
          compositeModelKey: 'openrouter::openai/gpt-5.4',
          provider: 'openrouter',
        });
        await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
        await ensureAssistantShellVisible(window);
        // Both answered decisions are history: no control can submit either again.
        await expect(child.getByText(childResult, { exact: true })).toBeVisible();
        await expect(child.getByRole('group', { name: 'Question for you' })).toHaveCount(0);
        await expect(child.getByRole('button', { name: 'Send answer' })).toHaveCount(0);
        await expect(approve).toHaveCount(0);
        await expect(
          child.getByRole('button', { exact: true, name: 'Decline brainstrike.readWorkspaceFile' })
        ).toHaveCount(0);
        await expect(root.getByTestId('host-child-waiting')).toHaveCount(0);
        expect(await childDecisions()).toEqual(answered);
        expect(modelCalls()).toBe(completedCalls);
        await window.screenshot({
          path: testInfo.outputPath('delegated-decisions-consumed.png'),
        });
      },
      workspace,
    });
  });
});
