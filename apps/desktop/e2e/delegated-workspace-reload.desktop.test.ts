import { expect, test } from './fixtures/electron-fixture';
import { readAssistantMockRequests, setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

/** Real Electron shell, native DB and workspace hydration; inference is mocked. */
test('restores distinct child tabs and native transcripts without executing a run @smoke', async ({
  window,
}, testInfo) => {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
  await setupAssistantMock(window, { message: 'Root fixture ready.' });
  await ensureAssistantShellVisible(window);
  const input = window.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Prepare the child workspace fixture');
  await window.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(window.getByText('Root fixture ready.').first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });

  const rootPanel = window.getByTestId('chat-panel');
  await expect(
    rootPanel.getByRole('button', { includeHidden: true, name: 'Regenerate response' })
  ).toHaveCount(1);
  await rootPanel.getByText('Prepare the child workspace fixture', { exact: true }).hover();
  await expect(
    rootPanel.getByRole('button', { includeHidden: true, name: 'Edit message' })
  ).toHaveCount(1);

  const requests = (await readAssistantMockRequests(window)) as Array<{
    data: { memory: { resourceId: string; threadId: string } };
  }>;
  expect(requests).toHaveLength(1);
  const memory = requests[0]?.data.memory;
  expect(memory).toMatchObject({ resourceId: expect.any(String), threadId: expect.any(String) });
  if (!memory) {
    throw new Error('The root request has no native memory identity');
  }
  await window.evaluate(async (memory) => {
    const api = (globalThis as typeof globalThis & { electronAPI?: unknown }).electronAPI;
    const query = (
      api as {
        db?: {
          query?: (
            sql: string,
            params?: readonly unknown[]
          ) => Promise<{ rows: Record<string, unknown>[] }>;
        };
      }
    )?.db?.query;
    if (!query) {
      throw new Error('Native database bridge unavailable');
    }
    const result = await query(
      `SELECT id, "resourceId" AS resource FROM mastra_threads WHERE id = $1 AND "resourceId" = $2`,
      [memory.threadId, memory.resourceId]
    );
    if (result.rows.length !== 1) {
      throw new Error('Expected the exact root from the outgoing request');
    }
    const root = result.rows[0];
    if (!(root && typeof root['id'] === 'string' && typeof root['resource'] === 'string')) {
      throw new Error('Root thread was not persisted');
    }
    await query(`UPDATE mastra_threads SET title = 'Child workspace verification' WHERE id = $1`, [
      root['id'],
    ]);
    await query(
      'INSERT INTO brainstrike_delegated_conversations (thread_id, owner_resource_id, root_thread_id, resource_id) VALUES ($1, $2, $1, $2)',
      [root['id'], root['resource']]
    );
    const ids: string[] = [];
    for (const [name, color] of [
      ['Cedar', 'emerald'],
      ['Flint', 'amber'],
    ]) {
      const child = `${root['id']}-${name}`;
      const resource = `${root['resource']}-${name}`;
      await query(
        `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt", metadata) VALUES ($1, $2, $3, NOW(), NOW(), '{}'::jsonb)`,
        [child, resource, name]
      );
      await query(
        `INSERT INTO brainstrike_delegated_conversations (thread_id, owner_resource_id, root_thread_id, parent_thread_id, resource_id, configuration, display_name, color) VALUES ($1, $2, $3, $3, $4, '{}'::jsonb, $5, $6)`,
        [child, root['resource'], root['id'], resource, name, color]
      );
      await query(
        `INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId") VALUES ($1, $2, $3::jsonb, 'user', 'v2', NOW(), $4)`,
        [
          `${child}-instructions`,
          child,
          JSON.stringify({
            content: `Instructions for ${name}`,
            format: 2,
            parts: [{ text: `Instructions for ${name}`, type: 'text' }],
          }),
          resource,
        ]
      );
      await query(
        `INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId") VALUES ($1, $2, $3::jsonb, 'assistant', 'v2', NOW(), $4)`,
        [
          `${child}-message`,
          child,
          JSON.stringify({
            content: `${name} saved native transcript`,
            format: 2,
            parts: [{ text: `${name} saved native transcript`, type: 'text' }],
          }),
          resource,
        ]
      );
      await query(
        'INSERT INTO brainstrike_assistant_message_parents (message_id, thread_id, resource_id, parent_id) VALUES ($1, $2, $3, NULL), ($4, $2, $3, $1)',
        [`${child}-instructions`, child, resource, `${child}-message`]
      );
      ids.push(
        `delegated-conversation:${encodeURIComponent(JSON.stringify([root['resource'], root['id'], child]))}`
      );
    }
    const snapshot = {
      apps: { openAppIds: ids, selection: { appId: ids[0], kind: 'app' } },
      editors: {},
      explorer: { byRoot: {} },
      fileTabs: { activeTabId: null, tabs: [] },
      roots: { focusedRootId: null, visibleRootIds: null },
      version: 1,
    };
    await query(
      'INSERT INTO brainstrike_assistant_thread_workspaces (thread_id, resource_id, payload, updated_at) VALUES ($1, $2, $3::jsonb, NOW()) ON CONFLICT (thread_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()',
      [root['id'], root['resource'], JSON.stringify(snapshot)]
    );
  }, memory);

  const unexpectedModelRequests: string[] = [];
  window.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/assistant')) {
      unexpectedModelRequests.push(request.url());
    }
  });
  await window.reload();
  await mockFileSystemOperations(window);
  await setupAssistantMock(window, { message: 'Opening a child must not request this.' });
  await ensureAssistantShellVisible(window);
  await window.getByRole('button', { exact: true, name: 'Child workspace verification' }).click();
  const cedar = window.getByRole('tab', { exact: true, name: 'Cedar' });
  const flint = window.getByRole('tab', { exact: true, name: 'Flint' });
  await expect(cedar).toBeVisible({ timeout: E2E_TIMEOUTS.tabVisibility });
  await expect(cedar).toHaveAttribute('aria-selected', 'true');
  await expect(window.getByText('Cedar saved native transcript', { exact: true })).toBeVisible();
  await cedar.focus();
  await cedar.press('ArrowRight');
  await expect(flint).toBeFocused();
  await flint.press('Enter');
  await expect(flint).toHaveAttribute('aria-selected', 'true');
  await expect(window.getByText('Flint saved native transcript', { exact: true })).toBeVisible();
  await cedar.click();
  await expect(window.getByText('Cedar saved native transcript', { exact: true })).toBeVisible();
  const childPanel = window.getByRole('region', { exact: true, name: 'Cedar' });
  await expect(childPanel.getByText('Instructions for Cedar', { exact: true })).toBeVisible();
  await expect(childPanel.getByRole('button', { name: 'Regenerate response' })).toHaveCount(0);
  await childPanel.getByText('Instructions for Cedar', { exact: true }).hover();
  await expect(
    childPanel.getByRole('button', { includeHidden: true, name: 'Edit message' })
  ).toHaveCount(0);
  await expect(childPanel.getByRole('textbox', { name: 'Message input' })).toBeDisabled();
  await window.getByRole('button', { exact: true, name: 'Close Flint' }).click();
  await expect(flint).toHaveCount(0);
  await expect(cedar).toHaveAttribute('aria-selected', 'true');
  // The page-side mock observes the post-reload view; the network listener above
  // also covers the interval before the mock is reinstalled after navigation.
  expect(await readAssistantMockRequests(window)).toHaveLength(0);
  expect(unexpectedModelRequests).toHaveLength(0);
  await window.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('restored-child-workspace.png'),
  });
  await expect(window.getByText('Cedar saved native transcript', { exact: true })).toBeVisible();
  await testInfo.attach('restored-child-workspace', {
    contentType: 'image/png',
    path: testInfo.outputPath('restored-child-workspace.png'),
  });
});
