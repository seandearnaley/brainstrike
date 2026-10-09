import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readHostThreadTree } from './utils/agent-host-log';
import {
  configureAssistantProvider,
  enableAssistantCatalogModel,
  readAssistantMockRequests,
  setupAssistantMock,
} from './utils/assistant-mock';
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

interface MessageParentEdgeRow {
  readonly messageId: string;
  readonly parentId: string | null;
  readonly threadId: string;
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

/**
 * Reads the edge rows for one thread. The thread under test is captured ONCE
 * (from the composer's live thread via the newest edge row) and then passed
 * explicitly — a recency-based lookup per read could silently retarget if a
 * background write bumps another thread's `updatedAt` mid-test.
 */
async function readThreadEdges(
  page: Page,
  threadId: string | null
): Promise<readonly MessageParentEdgeRow[]> {
  return await page.evaluate(async (scopedThreadId) => {
    const api = (window as Window & { electronAPI?: unknown }).electronAPI;
    const query = (
      api as {
        db?: {
          query?: (
            sql: string,
            params?: readonly unknown[]
          ) => Promise<{ rows?: readonly Record<string, unknown>[] }>;
        };
      }
    )?.db?.query;
    if (typeof query !== 'function') {
      throw new Error('Electron db.query bridge is not available');
    }
    const result = scopedThreadId
      ? await query(
          `SELECT edges.message_id AS "messageId",
                  edges.parent_id AS "parentId",
                  edges.thread_id AS "threadId"
             FROM brainstrike_assistant_message_parents AS edges
            WHERE edges.thread_id = $1
            ORDER BY edges.created_at ASC, edges.message_id ASC`,
          [scopedThreadId]
        )
      : await query(
          `SELECT edges.message_id AS "messageId",
                  edges.parent_id AS "parentId",
                  edges.thread_id AS "threadId"
             FROM brainstrike_assistant_message_parents AS edges
            ORDER BY edges.created_at DESC
            LIMIT 1`
        );
    return (result.rows ?? []) as unknown as MessageParentEdgeRow[];
  }, threadId);
}

/** Orders edges root-first; throws when the graph is not one linear chain. */
function toLinearChain(edges: readonly MessageParentEdgeRow[]): readonly string[] {
  const roots = edges.filter((edge) => edge.parentId === null);
  if (roots.length !== 1) {
    throw new Error(
      `Expected exactly one root edge, got ${roots.length}: ${JSON.stringify(edges)}`
    );
  }
  const childByParent = new Map<string, MessageParentEdgeRow>();
  for (const edge of edges) {
    if (edge.parentId === null) {
      continue;
    }
    if (childByParent.has(edge.parentId)) {
      throw new Error(`Sibling branch detected at parent ${edge.parentId}`);
    }
    childByParent.set(edge.parentId, edge);
  }
  const chain: string[] = [];
  let cursor: MessageParentEdgeRow | undefined = roots[0];
  while (cursor) {
    chain.push(cursor.messageId);
    cursor = childByParent.get(cursor.messageId);
  }
  if (chain.length !== edges.length) {
    throw new Error(
      `Edge graph is not one connected chain (${chain.length}/${edges.length}): ${JSON.stringify(edges)}`
    );
  }
  return chain;
}

async function seedContentRowsForChain(
  page: Page,
  args: {
    readonly chain: readonly string[];
    readonly threadId: string;
    readonly texts: readonly string[];
    readonly title: string;
  }
): Promise<void> {
  await page.evaluate(async ({ chain, threadId, texts, title }) => {
    const api = (window as Window & { electronAPI?: unknown }).electronAPI;
    const query = (
      api as {
        db?: {
          query?: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
        };
      }
    )?.db?.query;
    if (typeof query !== 'function') {
      throw new Error('Electron db.query bridge is not available');
    }
    const resourceResult = (await query(`SELECT "resourceId" FROM mastra_threads WHERE id = $1`, [
      threadId,
    ])) as { rows?: readonly Record<string, unknown>[] };
    const resourceId = resourceResult.rows?.[0]?.['resourceId'];
    if (typeof resourceId !== 'string') {
      throw new Error(`Thread ${threadId} has no resourceId`);
    }
    const base = Date.now() - chain.length * 1000;
    for (const [index, messageId] of chain.entries()) {
      const role = index % 2 === 0 ? 'user' : 'assistant';
      const text = texts[index] ?? `${role} message ${index + 1}`;
      await query(
        `INSERT INTO mastra_messages
             (id, thread_id, content, role, type, "createdAt", "resourceId")
           VALUES ($1, $2, $3::jsonb, $4, 'v2', $5, $6)`,
        [
          messageId,
          threadId,
          JSON.stringify({ content: text, format: 2, parts: [{ text, type: 'text' }] }),
          role,
          new Date(base + index * 1000).toISOString(),
          resourceId,
        ]
      );
    }
    await query('UPDATE mastra_threads SET title = $2 WHERE id = $1', [threadId, title]);
  }, args);
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

  test('a failed decision discovery preserves history and clears after successful reload', async ({
    modelProvider,
    window,
  }) => {
    await prepareMockWorkspace(window);
    const prompt = 'Keep this conversation while checking pending decisions.';
    const reply = 'This saved response must remain visible.';
    await configureAssistantProvider(window);
    modelProvider.setScript({ finalText: reply });
    await waitForAssistantChat(window);
    await sendPrompt(window, prompt);
    await expect(window.getByText(reply).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });
    const latest = await readThreadEdges(window, null);
    const threadId = latest[0]?.threadId;
    if (!threadId) {
      throw new Error('Expected the created conversation identity');
    }
    await expect.poll(async () => (await readThreadEdges(window, threadId)).length).toBe(2);
    const chain = toLinearChain(await readThreadEdges(window, threadId));
    const title = `Decision recovery E2E ${Date.now()}`;
    await seedContentRowsForChain(window, { chain, texts: [prompt, reply], threadId, title });
    let failDiscovery = true;
    await window.route('**/assistant/suspended-runs?*', async (route) => {
      await route.fulfill({
        body: JSON.stringify(
          failDiscovery
            ? { error: 'ambiguous delegated snapshot' }
            : { approvals: [], suspends: [] }
        ),
        contentType: 'application/json',
        status: failDiscovery ? 500 : 200,
      });
    });
    const reopen = async () => {
      await window.reload();
      const { mockFileSystemOperations } = await loadElectronHelpers();
      await mockFileSystemOperations(window);
      await ensureMockWorkspaceOpen(window);
      await setupAssistantMock(window, { variant: 'simple' });
      await waitForAssistantChat(window);
      await window
        .getByRole('treegrid', { name: 'Workspace threads' })
        .getByRole('button')
        .filter({ has: window.getByText(title, { exact: true }) })
        .click();
      await expect(window.getByText(prompt).first()).toBeVisible({
        timeout: E2E_TIMEOUTS.messageVisibility,
      });
      await expect(window.getByText(reply).first()).toBeVisible();
    };
    await reopen();
    const recovery = window
      .getByRole('alert')
      .filter({ hasText: 'Pending decisions could not be restored' });
    await expect(recovery).toBeVisible();
    await expect(recovery).toContainText('Reopen this thread to check again.');
    expect(await readAssistantMockRequests(window)).toHaveLength(0);
    expect(await readThreadEdges(window, threadId)).toHaveLength(2);
    failDiscovery = false;
    await reopen();
    await expect(recovery).toHaveCount(0);
    expect(await readThreadEdges(window, threadId)).toHaveLength(2);
    expect(await readAssistantMockRequests(window)).toHaveLength(0);
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
