import { expect, test } from './fixtures/electron-fixture';
import {
  configureAssistantProvider,
  readAssistantMockRequests,
  setupAssistantMock,
} from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

/** Real Electron shell, native DB and workspace hydration; inference is mocked. */
test('restores distinct child tabs and native transcripts without executing a run @smoke', async ({
  modelProvider,
  window,
}, testInfo) => {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  modelProvider.setScript({ finalText: 'Root fixture ready.' });
  await ensureAssistantShellVisible(window);
  const input = window.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Prepare the child workspace fixture');
  await window.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(window.getByText('Root fixture ready.').first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });

  const rootPanel = window.getByRole('region', { exact: true, name: 'Assistant' });
  await expect(
    rootPanel.getByRole('button', { includeHidden: true, name: 'Regenerate response' })
  ).toHaveCount(1);
  await rootPanel.getByText('Prepare the child workspace fixture', { exact: true }).hover();
  await expect(
    rootPanel.getByRole('button', { includeHidden: true, name: 'Edit message' })
  ).toHaveCount(1);

  const requests = (await readAssistantMockRequests(window)) as Array<{
    data: { memory: { resourceId: string; runId: string; threadId: string } };
  }>;
  expect(requests).toHaveLength(1);
  const memory = requests[0]?.data.memory;
  expect(memory).toMatchObject({
    resourceId: expect.any(String),
    runId: expect.any(String),
    threadId: expect.any(String),
  });
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
    // setupAssistantMock replaces the host transport, including its replay headers.
    // This completed-history fixture must seed the terminal write that the real
    // admitted host owns; renderer cleanup deliberately does not perform it.
    const completed = await query(
      `UPDATE brainstrike_assistant_thread_runs
       SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND resource_id = $2 AND thread_id = $3 AND status = 'running'
       RETURNING id`,
      [memory.runId, memory.resourceId, memory.threadId]
    );
    if (completed.rows.length !== 1) {
      throw new Error('Expected the exact mock-prepared run to complete');
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
    const fixturePersona = {
      allowedToolIds: ['brainstrike.readWorkspaceFile'],
      description: 'Inspect the persisted child workspace fixture.',
      id: 'workspace-reload-fixture',
      instructions: 'Read the requested workspace context and report the result.',
      label: 'Workspace fixture',
      maxSteps: 16,
    };
    const ids: string[] = [];
    for (const [name, color, parentName] of [
      ['Cedar', 'emerald'],
      ['Flint', 'family:2000:730'],
      ['Wren', 'family:1510:420', 'Cedar'],
    ]) {
      const child = `${root['id']}-${name}`;
      const resource = `${root['resource']}-${name}`;
      await query(
        `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt", metadata) VALUES ($1, $2, $3, NOW(), NOW(), '{}'::jsonb)`,
        [child, resource, name]
      );
      await query(
        'INSERT INTO brainstrike_delegated_conversations (thread_id, owner_resource_id, root_thread_id, parent_thread_id, resource_id, configuration, display_name, color) VALUES ($1, $2, $3, $7, $4, $8::jsonb, $5, $6)',
        [
          child,
          root['resource'],
          root['id'],
          resource,
          name,
          color,
          parentName ? `${root['id']}-${parentName}` : root['id'],
          JSON.stringify({ maxSteps: fixturePersona.maxSteps, persona: fixturePersona }),
        ]
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
            parts: [
              {
                text: `${name} saved native transcript\n\n${Array.from(
                  { length: 180 },
                  (_, index) =>
                    `${name} evidence paragraph ${index}: inspect this child independently.`
                ).join('\n\n')}`,
                type: 'text',
              },
            ],
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
      apps: { openAppIds: ids.slice(0, 2), selection: { appId: ids[0], kind: 'app' } },
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
    const otherId = `${root['id']}-other-root`;
    await query(
      `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt", metadata) VALUES ($1, $2, 'Other root navigation', NOW(), NOW(), '{}'::jsonb)`,
      [otherId, root['resource']]
    );
    await query(
      "INSERT INTO brainstrike_assistant_thread_workspaces (thread_id, resource_id, payload, updated_at) VALUES ($1, $2, $3::jsonb, TIMESTAMPTZ '2000-01-01')",
      [
        otherId,
        root['resource'],
        JSON.stringify({ ...snapshot, apps: { openAppIds: [], selection: { kind: 'empty' } } }),
      ]
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
  await window
    .getByTestId('thread-row')
    .getByRole('button', { exact: true, name: 'Child workspace verification' })
    .click();
  const cedar = window.getByRole('tab', { exact: true, name: 'Cedar' });
  const flint = window.getByRole('tab', { exact: true, name: 'Flint' });
  await expect(cedar).toBeVisible({ timeout: E2E_TIMEOUTS.tabVisibility });
  await expect(cedar).toHaveAttribute('aria-selected', 'true');
  // The shared TabStrip carries the consumer's data-agent-color hook on the tab itself.
  await expect(cedar).toHaveAttribute('data-agent-color', 'emerald');
  await expect(flint).toHaveAttribute('data-agent-color', 'family:2000:730');
  await expect(cedar.getByTestId('workspace-agent-mark')).toHaveCSS(
    'background-color',
    'oklch(0.696 0.17 162.48)'
  );
  await expect(flint.getByTestId('workspace-agent-mark')).toHaveClass(/bs-agent-family-mark/u);
  const flintMarkBackground = await flint
    .getByTestId('workspace-agent-mark')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(flintMarkBackground).not.toBe('rgba(0, 0, 0, 0)');
  await expect(window.getByText('Cedar saved native transcript', { exact: true })).toBeVisible();
  const rootDraft = rootPanel.getByRole('textbox', { name: 'Message input' });
  await rootDraft.fill('UNSENT_PARENT_DRAFT_1724');
  const cedarPanel = window.getByRole('region', { exact: true, name: 'Cedar' });
  const cedarViewport = cedarPanel.getByTestId('assistant-ui-viewport');
  await expect
    .poll(() =>
      cedarViewport.evaluate((element) => element.scrollHeight > element.clientHeight * 3)
    )
    .toBe(true);
  await cedarViewport.evaluate((element) => element.scrollTo({ behavior: 'instant', top: 0 }));
  await expect.poll(() => cedarViewport.evaluate((element) => element.scrollTop)).toBe(0);
  // Wait for the scroll owner to record that Cedar is reading history before
  // hiding its kept-alive panel. A DOM scrollTop write precedes its scroll
  // event; switching tabs before that event leaves the follow state pinned.
  await expect(cedarPanel.getByTestId('assistant-scroll-to-bottom')).toBeEnabled();
  await cedar.focus();
  await cedar.press('ArrowRight');
  await expect(flint).toBeFocused();
  await flint.press('Enter');
  await expect(flint).toHaveAttribute('aria-selected', 'true');
  await expect(window.getByText('Flint saved native transcript', { exact: true })).toBeVisible();
  const flintViewport = window
    .getByRole('region', { exact: true, name: 'Flint' })
    .getByTestId('assistant-ui-viewport');
  await expect
    .poll(() => flintViewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);
  await cedar.click();
  await expect(cedar).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => cedarViewport.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(rootDraft).toHaveValue('UNSENT_PARENT_DRAFT_1724');
  await expect(window.getByText('Cedar saved native transcript', { exact: true })).toBeVisible();
  const childPanel = window.getByRole('region', { exact: true, name: 'Cedar' });
  await expect(childPanel.getByText('Instructions for Cedar', { exact: true })).toBeVisible();
  await expect(
    childPanel.getByRole('button', { includeHidden: true, name: 'Regenerate response' })
  ).toHaveCount(1);
  await childPanel.getByText('Instructions for Cedar', { exact: true }).hover();
  await expect(
    childPanel.getByRole('button', { includeHidden: true, name: 'Edit message' })
  ).toHaveCount(1);
  // Reloaded idle children expose their branch controls and accept their own
  // draft. Merely restoring the controls or editing the draft must not run a
  // model or change the parent's composer. Delivery is covered separately.
  const childInput = childPanel.getByRole('textbox', { name: 'Message input' });
  await expect(childInput).toBeEnabled();
  await childInput.fill('UNSENT_CHILD_DRAFT_1724');
  await expect(rootDraft).toHaveValue('UNSENT_PARENT_DRAFT_1724');
  await expect(
    childPanel.getByRole('button', { includeHidden: true, name: 'Restore to before this message' })
  ).toHaveCount(0);
  // The tab ✕ is a mouse-only, aria-hidden sibling of the tab that shows on
  // hover (TabStrip contract), so point at the inactive Flint tab first.
  await flint.hover();
  await window
    .getByRole('button', { exact: true, includeHidden: true, name: 'Close Flint' })
    .click();
  await expect(flint).toHaveCount(0);
  await expect(cedar).toHaveAttribute('aria-selected', 'true');
  // Expand the actual shared TreeTable; listing children mounts no transcripts.
  const rootRow = window.getByRole('row').filter({
    has: window.getByRole('button', { exact: true, name: 'Child workspace verification' }),
  });
  await rootRow.getByRole('button', { name: /Expand/ }).click();
  const sidebarCedar = window.getByRole('row').filter({
    has: window.getByRole('button', { exact: true, name: 'Cedar Child' }),
  });
  await expect(sidebarCedar).toBeVisible();
  await expect(
    window.getByRole('region', { exact: true, includeHidden: true, name: 'Wren' })
  ).toHaveCount(0);
  // Establish the reader's position before the sidebar navigation sequence.
  await cedarViewport.evaluate((element) => element.scrollTo({ behavior: 'instant', top: 0 }));
  await expect
    .poll(() => cedarViewport.evaluate((element) => element.scrollTop))
    .toBeLessThanOrEqual(1);
  await window.getByRole('button', { exact: true, name: 'Flint Child' }).click();
  await expect(flint).toHaveAttribute('aria-selected', 'true');
  await expect(flint).toHaveAttribute('data-agent-color', 'family:2000:730');
  await expect(flint.getByTestId('workspace-agent-mark')).toHaveClass(/bs-agent-family-mark/u);
  await expect(flint.getByTestId('workspace-agent-mark')).toHaveCSS(
    'background-color',
    flintMarkBackground
  );
  await sidebarCedar.getByRole('button', { name: /Expand/ }).click();
  const wrenRow = window.getByRole('row').filter({
    has: window.getByRole('button', { exact: true, name: 'Wren Child' }),
  });
  await expect(wrenRow).toHaveAttribute('aria-level', '3');
  const wrenButton = wrenRow.getByRole('button', { exact: true, name: 'Wren Child' });
  await wrenButton.focus();
  await wrenButton.press('Enter');
  await expect(window.getByRole('tab', { exact: true, name: 'Wren' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  const wrenPanel = window.getByRole('tabpanel', { exact: true, name: 'Wren' });
  await expect(wrenPanel.getByRole('navigation', { name: 'Conversation ancestry' })).toContainText(
    'Cedar'
  );
  await wrenPanel.getByRole('button', { exact: true, name: 'Cedar' }).click();
  await expect(cedar).toHaveAttribute('aria-selected', 'true');
  await expect(cedar).toBeFocused();
  await expect.poll(() => cedarViewport.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(rootDraft).toHaveValue('UNSENT_PARENT_DRAFT_1724');
  // Open an existing child's sidebar row while another root owns the workspace.
  await window.getByRole('button', { exact: true, name: 'Other root navigation' }).click();
  await expect(cedar).toHaveCount(0);
  await sidebarCedar.getByRole('button', { exact: true, name: 'Cedar Child' }).click();
  await expect(cedar).toHaveAttribute('aria-selected', 'true');
  await expect(rootDraft).toHaveValue('UNSENT_PARENT_DRAFT_1724');
  const readOtherWorkspace = () =>
    window.evaluate(async (rootId) => {
      const api = (
        globalThis as typeof globalThis & {
          electronAPI?: {
            db?: {
              query?: (
                sql: string,
                params: readonly unknown[]
              ) => Promise<{
                rows: Array<{ payload: { apps: { openAppIds: string[] } }; persisted: boolean }>;
              }>;
            };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Native database bridge unavailable');
      }
      const result = await api.db.query(
        "SELECT payload, updated_at > TIMESTAMPTZ '2000-01-01' AS persisted FROM brainstrike_assistant_thread_workspaces WHERE thread_id = $1",
        [`${rootId}-other-root`]
      );
      return result.rows[0];
    }, memory.threadId);
  // Observe the outgoing write, not the empty seed before it has persisted.
  await expect.poll(async () => (await readOtherWorkspace())?.persisted).toBe(true);
  expect((await readOtherWorkspace())?.payload.apps.openAppIds).toEqual([]);
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

  // Delete through the actual sidebar action, then reload. The other root and
  // its workspace survive; stale saved child tabs may never revive work.
  await rootRow
    .getByRole('button', { name: 'Thread actions Child workspace verification' })
    .click();
  await window.getByRole('button', { exact: true, name: 'Delete…' }).click();
  await window
    .getByRole('button', { name: 'Confirm delete thread Child workspace verification' })
    .click();
  await expect(rootRow).toHaveCount(0);
  await expect(cedar).toHaveCount(0);
  await expect(flint).toHaveCount(0);
  await expect(window.getByRole('tab', { exact: true, name: 'Wren' })).toHaveCount(0);
  const deletedRows = await window.evaluate(async (rootId) => {
    const api = (
      globalThis as typeof globalThis & {
        electronAPI?: {
          db?: {
            query?: (
              sql: string,
              values: string[][]
            ) => Promise<{ rows: Array<{ kind: string; count: string }> }>;
          };
        };
      }
    ).electronAPI;
    if (!api?.db?.query) {
      throw new Error('Native database bridge unavailable');
    }
    return (
      await api.db.query(
        `SELECT 'native' AS kind, count(*)::text FROM mastra_threads WHERE id = ANY($1::text[])
       UNION ALL SELECT 'messages', count(*)::text FROM mastra_messages WHERE thread_id = ANY($1::text[])
       UNION ALL SELECT 'graph', count(*)::text FROM brainstrike_delegated_conversations WHERE thread_id = ANY($1::text[])
       UNION ALL SELECT 'workspace', count(*)::text FROM brainstrike_assistant_thread_workspaces WHERE thread_id = ANY($1::text[])
       ORDER BY kind`,
        [[rootId, `${rootId}-Cedar`, `${rootId}-Flint`, `${rootId}-Wren`]]
      )
    ).rows;
  }, memory.threadId);
  expect(deletedRows).toEqual([
    { count: '0', kind: 'graph' },
    { count: '0', kind: 'messages' },
    { count: '0', kind: 'native' },
    { count: '0', kind: 'workspace' },
  ]);

  await window.reload();
  await mockFileSystemOperations(window);
  await setupAssistantMock(window, { message: 'Deleted children must never execute.' });
  await ensureAssistantShellVisible(window);
  await expect(
    window.getByRole('button', { exact: true, name: 'Other root navigation' })
  ).toBeVisible();
  await expect(window.getByRole('tab', { exact: true, name: 'Cedar' })).toHaveCount(0);
  await expect(window.getByRole('button', { exact: true, name: 'Cedar Child' })).toHaveCount(0);
  expect(await readAssistantMockRequests(window)).toHaveLength(0);
  expect(unexpectedModelRequests).toHaveLength(0);
});
