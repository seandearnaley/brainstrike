import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

/**
 * BST-1243: a linear conversation containing a suspend/approval decision must
 * stay linear — live and across a reload. The decision's action echo and the
 * post-resume leg are UI-transient (never Mastra rows); if the history adapter
 * persists their ids into `brainstrike_assistant_message_parents`, the next
 * user turn chains onto a ghost and reload hydration fans the thread into
 * root carousel siblings (the 3-exchanges-become-3/3 regression).
 *
 * Half 1 drives the REAL runtime + adapter and asserts the durable edge table
 * directly. Half 2 seeds the content rows the mocked server never persisted
 * (edges under test stay REAL) and asserts the reloaded thread renders as one
 * stream with no branch carousel.
 */

const FIRST_PROMPT = 'Use Python to inspect a package index';
const FOLLOW_UP_PROMPT = 'Now summarize what you found.';
const FOLLOW_UP_REPLY = 'Summary after the network decision.';

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
  await expect(window.getByTestId('chat-panel')).toBeVisible({
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
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await ensureMockWorkspaceOpen(window);
  });

  test('a suspend decision mid-thread persists only durable edges and reloads as one stream', async ({
    window,
  }) => {
    await setupAssistantMock(window, { variant: 'network-suspend' });
    await waitForAssistantChat(window);
    await sendPrompt(window, FIRST_PROMPT);

    const notice = window.getByTestId('assistant-run-python-network-notice');
    await expect(notice).toBeVisible({ timeout: E2E_TIMEOUTS.toolVisibility });
    await window.getByTestId('run-python-network-domain-pypi.org').click();
    await window.getByTestId('run-python-network-domain-*.githubusercontent.com').click();
    await window.getByTestId('run-python-network-allow').click();
    await expect(window.getByText('Network decision resumed.').first()).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });

    // Follow-up turn — the message whose parent edge the bug corrupted.
    await setupAssistantMock(window, { message: FOLLOW_UP_REPLY, variant: 'simple' });
    await sendPrompt(window, FOLLOW_UP_PROMPT);
    await expect(window.getByText(FOLLOW_UP_REPLY).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });

    // Capture the thread under test ONCE, from the newest edge the live flow
    // just wrote, then scope every subsequent read to it explicitly.
    const newestEdge = (await readThreadEdges(window, null))[0];
    const threadId = newestEdge?.threadId;
    if (!threadId) {
      throw new Error('No edge rows were written by the live flow.');
    }

    // Half 1 — durable-parent invariant on the REAL edge table. The follow-up
    // assistant edge lands at runEnd, slightly after its reply renders.
    await expect
      .poll(async () => (await readThreadEdges(window, threadId)).length, {
        timeout: E2E_TIMEOUTS.messageVisibility,
      })
      .toBe(4);
    const edges = await readThreadEdges(window, threadId);
    // Re-assert the count on the snapshot actually used below, so a late
    // extra edge fails legibly here instead of inside the chain walk.
    expect(edges).toHaveLength(4);
    const chain = toLinearChain(edges);
    expect(chain).toHaveLength(4);

    // Half 2 — seed the content rows the mocked server never persisted (the
    // edges stay exactly as the live flow wrote them), then reload.
    const title = `Approval linearity E2E ${Date.now()}`;
    await seedContentRowsForChain(window, {
      chain,
      texts: [FIRST_PROMPT, 'Network decision resumed.', FOLLOW_UP_PROMPT, FOLLOW_UP_REPLY],
      threadId,
      title,
    });

    await window.reload();
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await ensureMockWorkspaceOpen(window);
    await waitForAssistantChat(window);
    await window.getByRole('button', { exact: true, name: title }).click();

    // One linear stream: all four turns visible, no branch carousel anywhere.
    for (const text of [FIRST_PROMPT, 'Network decision resumed.', FOLLOW_UP_PROMPT]) {
      await expect(window.getByText(text).first()).toBeVisible({
        timeout: E2E_TIMEOUTS.messageVisibility,
      });
    }
    await expect(window.getByLabel('Previous branch')).toHaveCount(0);
    await expect(window.getByLabel('Next branch')).toHaveCount(0);
  });
});
