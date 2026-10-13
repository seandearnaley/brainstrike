import { expect, test } from './fixtures/electron-fixture';
import {
  hostThreadExists,
  readHostThreadTree,
  readHostThreadWorkspace,
} from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import {
  ensureActivityExpanded,
  ensureAssistantShellVisible,
  ensureMockWorkspaceOpen,
} from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import type { ModelProviderRequest, ModelProviderScript } from './utils/model-provider-shim';
import { E2E_TIMEOUTS } from './utils/timeouts';

const ROOT_PROMPT = 'Prepare the child workspace fixture';
const ROOT_TITLE = 'Child workspace verification';
const OTHER_PROMPT = 'OTHER_ROOT_PROMPT_1724';
const OTHER_TITLE = 'Other root navigation';
const TASKS = {
  first: 'FIRST_CHILD_TASK_1724',
  grand: 'GRAND_CHILD_TASK_1724',
  second: 'SECOND_CHILD_TASK_1724',
} as const;
const SAVED = {
  first: 'First child saved native transcript',
  grand: 'Grandchild saved native transcript',
  second: 'Second child saved native transcript',
} as const;

/** A long final answer, so each restored child's transcript scrolls on its own. */
function transcript(saved: string): string {
  return `${saved}\n\n${Array.from(
    { length: 180 },
    (_, index) => `${saved} evidence paragraph ${index}: inspect this child independently.`
  ).join('\n\n')}`;
}

/** The agent's own task: its user messages, without a background wake's ledger. */
function taskOf({ messages }: ModelProviderRequest): string {
  return JSON.stringify(
    messages.filter(
      (message) =>
        message &&
        typeof message === 'object' &&
        'role' in message &&
        message.role === 'user' &&
        !JSON.stringify(message).includes('Background invocations of this turn')
    )
  );
}

/**
 * Only the model is scripted. The root delegates two background Workers, the
 * first of which delegates a foreground Worker; each child answers with a long
 * transcript. A title request (it advertises no tools) names its root.
 */
function scriptDelegationTree(request: ModelProviderRequest): ModelProviderScript {
  const task = taskOf(request);
  const isChild = Object.values(TASKS).some((marker) => task.includes(marker));
  if (request.toolNames.length === 0) {
    if (task.includes(OTHER_PROMPT)) {
      return { finalText: OTHER_TITLE };
    }
    return { finalText: isChild ? 'Delegated task' : ROOT_TITLE };
  }
  const history = JSON.stringify(request.messages);
  if (task.includes(TASKS.grand)) {
    return { finalText: transcript(SAVED.grand) };
  }
  if (task.includes(TASKS.first)) {
    return history.includes(SAVED.grand)
      ? { finalText: transcript(SAVED.first) }
      : {
          finalText: transcript(SAVED.first),
          toolCall: {
            arguments: { _background: { enabled: false }, prompt: TASKS.grand },
            name: 'agent-worker',
          },
        };
  }
  if (task.includes(TASKS.second)) {
    return { finalText: transcript(SAVED.second) };
  }
  if (task.includes(OTHER_PROMPT)) {
    return { finalText: 'Other root ready.' };
  }
  if (history.includes(SAVED.first) && history.includes(SAVED.second)) {
    return { finalText: 'Root fixture ready.' };
  }
  if (history.includes('Background task started.')) {
    return { finalText: 'Root dispatched its children.' };
  }
  return {
    finalText: 'Root dispatched its children.',
    toolCalls: [
      {
        arguments: { _background: { enabled: true }, prompt: TASKS.first },
        name: 'agent-worker',
      },
      {
        arguments: { _background: { enabled: true }, prompt: TASKS.second },
        name: 'agent-worker',
      },
    ],
  };
}

/**
 * The fixture's threads as the agent host committed them, found by the task
 * each began with: both roots, and each delegated child's call sign, colour,
 * status and parent. `settled` is true once no thread has a run in progress.
 */
async function readFixtureTree(userDataDir: string) {
  const logs = await readHostThreadTree(userDataDir);
  const task = (log: (typeof logs)[number]) =>
    log.rows.flatMap(({ event }) => (event.type === 'run.started' ? [event.prompt] : []))[0];
  const child = (prompt: string) => {
    const log = logs.find(
      (candidate) => candidate.parentThreadId !== undefined && task(candidate) === prompt
    );
    return log?.child && log.parentThreadId
      ? { ...log.child, parentThreadId: log.parentThreadId, threadId: log.threadId }
      : undefined;
  };
  const running = logs.some(({ rows }) => {
    const started = rows.filter(({ event }) => event.type === 'run.started').length;
    return started !== rows.filter(({ event }) => event.type === 'run.finished').length;
  });
  return {
    first: child(TASKS.first),
    grand: child(TASKS.grand),
    other: logs.find((log) => log.parentThreadId === undefined && task(log) === OTHER_PROMPT)
      ?.threadId,
    root: logs.find((log) => log.parentThreadId === undefined && task(log) === ROOT_PROMPT)
      ?.threadId,
    second: child(TASKS.second),
    settled: !(running || logs.some(({ child: listed }) => listed && listed.status !== 'idle')),
  };
}

const CHILD_TAB_PREFIX = 'host-child-thread:';

/** The child thread a host child tab addresses ([threadId, persona]); other apps (Files) are not. */
function childTabThread(appId: string): string | undefined {
  if (!appId.startsWith(CHILD_TAB_PREFIX)) {
    return;
  }
  const address: unknown = JSON.parse(decodeURIComponent(appId.slice(CHILD_TAB_PREFIX.length)));
  return Array.isArray(address) && typeof address[0] === 'string' ? address[0] : undefined;
}

/** A root's saved child tabs, in tab order, and the child its selection names. */
async function readSavedChildTabs(userDataDir: string, threadId: string) {
  const apps = (await readHostThreadWorkspace(userDataDir, threadId))?.apps;
  if (!apps) {
    return null;
  }
  return {
    open: apps.openAppIds.flatMap((appId) => {
      const child = childTabThread(appId);
      return child ? [child] : [];
    }),
    selected: apps.selection.kind === 'app' ? childTabThread(apps.selection.appId) : undefined,
  };
}

/** Real Electron shell, agent host, delegation tree and workspace hydration; inference is mocked. */
test('restores distinct child tabs and native transcripts without executing a run @smoke', async ({
  electron,
  modelProvider,
  window,
}, testInfo) => {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  modelProvider.setScript(scriptDelegationTree);
  await ensureAssistantShellVisible(window);
  const userDataDir = electron.getUserDataDir();
  // Agent turns advertise tools; a thread-title request has none.
  const modelCalls = (): number =>
    modelProvider.requests().filter(({ toolNames }) => toolNames.length > 0).length;
  const rootPanel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const rootDraft = rootPanel.getByRole('textbox', { name: 'Message input' });
  await expect(rootDraft).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await rootDraft.fill(ROOT_PROMPT);
  await rootPanel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(rootPanel.getByText('Root fixture ready.', { exact: true })).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  expect(modelProvider.requests()[0]?.toolNames, 'The root must offer Worker').toContain(
    'agent-worker'
  );
  // Two Workers under the root, a third under the first, and no run left in progress.
  await expect
    .poll(async () => {
      const { first, grand, root, second, settled } = await readFixtureTree(userDataDir);
      return {
        firstUnderRoot: root !== undefined && first?.parentThreadId === root,
        grandUnderFirst: first !== undefined && grand?.parentThreadId === first.threadId,
        secondUnderRoot: root !== undefined && second?.parentThreadId === root,
        settled,
      };
    })
    .toEqual({ firstUnderRoot: true, grandUnderFirst: true, secondUnderRoot: true, settled: true });
  const tree = await readFixtureTree(userDataDir);
  const { first, grand, root, second } = tree;
  if (!(first && grand && root && second)) {
    throw new Error('The host committed an incomplete delegation tree');
  }

  // Open both delegated Workers from the root's cards (in call order), the first selected.
  const selectedTab = window
    .getByRole('tablist', { name: 'Workspace tabs' })
    .getByRole('tab', { selected: true });
  // Each delegation is its own activity group; the root's answers hold no others.
  const delegations = rootPanel.getByTestId('assistant-activity-group');
  await expect(delegations).toHaveCount(2);
  for (const [index, child] of [first, second].entries()) {
    const delegation = delegations.nth(index);
    await ensureActivityExpanded(delegation);
    await delegation.getByRole('button', { name: /Open .* conversation/ }).click();
    await expect(selectedTab).toHaveText(child.callSign);
  }
  const cedar = window.getByRole('tab', { exact: true, name: first.callSign });
  const flint = window.getByRole('tab', { exact: true, name: second.callSign });
  await cedar.click();
  await expect(cedar).toHaveAttribute('aria-selected', 'true');
  // The root's saved workspace holds both child tabs, the first selected.
  await expect
    .poll(() => readSavedChildTabs(userDataDir, root))
    .toEqual({ open: [first.threadId, second.threadId], selected: first.threadId });

  // A second root, through a real send.
  // The new-thread control sits in the thread strip, beside the conversation.
  await window.getByTestId('assistant-new-thread-button').click();
  // Each thread keeps its panel mounted: the new root is its own tab panel,
  // renamed from New Thread to its generated title as its first run completes.
  const otherPanel = window
    .getByRole('tabpanel', { name: /^(?:New Thread|Other root navigation)$/u })
    .getByRole('region', { exact: true, name: 'Assistant' });
  await otherPanel.getByRole('textbox', { name: 'Message input' }).fill(OTHER_PROMPT);
  await otherPanel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(otherPanel.getByText('Other root ready.', { exact: true })).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  const threadRow = (title: string) =>
    window.getByTestId('thread-row').getByRole('button', { exact: true, name: title });
  await expect(threadRow(OTHER_TITLE)).toBeVisible();
  await expect(threadRow(ROOT_TITLE)).toBeVisible();
  await expect
    .poll(async () => {
      const { other, settled } = await readFixtureTree(userDataDir);
      return other !== undefined && settled;
    })
    .toBe(true);
  const other = (await readFixtureTree(userDataDir)).other;
  if (!other) {
    throw new Error('The host committed no second root');
  }

  // Every agent turn from here on would be a child or root executing.
  const settledModelCalls = modelCalls();
  await window.reload();
  await mockFileSystemOperations(window);
  await ensureAssistantShellVisible(window);
  await threadRow(ROOT_TITLE).click();
  await expect(cedar).toBeVisible({ timeout: E2E_TIMEOUTS.tabVisibility });
  await expect(cedar).toHaveAttribute('aria-selected', 'true');
  // The shared TabStrip carries each child's host-allocated family colour on the tab.
  await expect(cedar).toHaveAttribute('data-agent-color', first.color);
  await expect(flint).toHaveAttribute('data-agent-color', second.color);
  await expect(cedar.getByTestId('workspace-agent-mark')).toHaveClass(/bs-agent-family-mark/u);
  await expect(flint.getByTestId('workspace-agent-mark')).toHaveClass(/bs-agent-family-mark/u);
  const markBackground = (tab: typeof cedar) =>
    tab
      .getByTestId('workspace-agent-mark')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  const flintMarkBackground = await markBackground(flint);
  expect(flintMarkBackground).not.toBe('rgba(0, 0, 0, 0)');
  expect(await markBackground(cedar)).not.toBe(flintMarkBackground);
  await expect(window.getByText(SAVED.first, { exact: true })).toBeVisible();
  const rootComposer = window
    .getByRole('tabpanel', { exact: true, name: ROOT_TITLE })
    .getByRole('region', { exact: true, name: 'Assistant' })
    .getByRole('textbox', { name: 'Message input' });
  await rootComposer.fill('UNSENT_PARENT_DRAFT_1724');
  // Navigating a root's children never changes which root thread is open.
  const rootThreadTab = window
    .getByRole('tablist', { name: 'Open assistant threads' })
    .getByRole('tab', { exact: true, name: ROOT_TITLE });
  const cedarPanel = window.getByRole('region', { exact: true, name: first.callSign });
  const cedarViewport = cedarPanel.getByTestId('assistant-ui-viewport');
  await expect
    .poll(() =>
      cedarViewport.evaluate((element) => element.scrollHeight > element.clientHeight * 3)
    )
    .toBe(true);
  // A restored panel is pinned and the follow engine completes its smooth scroll to
  // the end over several frames; a reader placed mid-animation lands short of the
  // top. Wait until the follow has finished: at the bottom, and no longer moving.
  let settled = '';
  await expect
    .poll(async () => {
      const position = await cedarViewport.evaluate(
        (element) =>
          `${element.scrollTop}|${element.scrollHeight}|${
            Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight) <= 1
          }`
      );
      const stable = position === settled && position.endsWith('|true');
      settled = position;
      return stable;
    })
    .toBe(true);
  await cedarViewport.evaluate((element) => element.scrollTo({ behavior: 'instant', top: 0 }));
  await expect.poll(() => cedarViewport.evaluate((element) => element.scrollTop)).toBe(0);
  // Wait for the scroll owner to record that the first child is reading history
  // before hiding its kept-alive panel. A DOM scrollTop write precedes its scroll
  // event; switching tabs before that event leaves the follow state pinned.
  await expect(cedarPanel.getByTestId('assistant-scroll-to-bottom')).toBeEnabled();
  await cedar.focus();
  await cedar.press('ArrowRight');
  await expect(flint).toBeFocused();
  await flint.press('Enter');
  await expect(flint).toHaveAttribute('aria-selected', 'true');
  await expect(window.getByText(SAVED.second, { exact: true })).toBeVisible();
  const flintViewport = window
    .getByRole('region', { exact: true, name: second.callSign })
    .getByTestId('assistant-ui-viewport');
  await expect
    .poll(() => flintViewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);
  await cedar.click();
  await expect(cedar).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => cedarViewport.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(rootComposer).toHaveValue('UNSENT_PARENT_DRAFT_1724');
  await expect(window.getByText(SAVED.first, { exact: true })).toBeVisible();
  await expect(cedarPanel.getByText(TASKS.first, { exact: true })).toBeVisible();
  await expect(
    cedarPanel.getByRole('button', { includeHidden: true, name: 'Regenerate response' })
  ).toHaveCount(1);
  await cedarPanel.getByText(TASKS.first, { exact: true }).hover();
  await expect(
    cedarPanel.getByRole('button', { includeHidden: true, name: 'Edit message' })
  ).toHaveCount(1);
  // Reloaded idle children expose their branch controls and accept their own
  // draft. Merely restoring the controls or editing the draft must not run a
  // model or change the parent's composer. Delivery is covered separately.
  const childInput = cedarPanel.getByRole('textbox', { name: 'Message input' });
  await expect(childInput).toBeEnabled();
  await childInput.fill('UNSENT_CHILD_DRAFT_1724');
  await expect(rootComposer).toHaveValue('UNSENT_PARENT_DRAFT_1724');
  await expect(
    cedarPanel.getByRole('button', { includeHidden: true, name: 'Restore to before this message' })
  ).toHaveCount(0);
  // The tab ✕ is a mouse-only, aria-hidden sibling of the tab that shows on
  // hover (TabStrip contract), so point at the inactive second tab first.
  await flint.hover();
  await window
    .getByRole('button', { exact: true, includeHidden: true, name: `Close ${second.callSign}` })
    .click();
  await expect(flint).toHaveCount(0);
  await expect(cedar).toHaveAttribute('aria-selected', 'true');
  // Expand the actual shared TreeTable; listing children mounts no transcripts.
  const rootRow = window.getByRole('row').filter({ has: threadRow(ROOT_TITLE) });
  await rootRow.getByRole('button', { name: /Expand/ }).click();
  const childRow = (callSign: string) =>
    window.getByRole('row').filter({
      has: window.getByRole('button', { exact: true, name: `${callSign} Child` }),
    });
  const sidebarCedar = childRow(first.callSign);
  await expect(sidebarCedar).toBeVisible();
  await expect(
    window.getByRole('region', { exact: true, includeHidden: true, name: grand.callSign })
  ).toHaveCount(0);
  // Establish the reader's position before the sidebar navigation sequence.
  await cedarViewport.evaluate((element) => element.scrollTo({ behavior: 'instant', top: 0 }));
  await expect
    .poll(() => cedarViewport.evaluate((element) => element.scrollTop))
    .toBeLessThanOrEqual(1);
  await window.getByRole('button', { exact: true, name: `${second.callSign} Child` }).click();
  await expect(flint).toHaveAttribute('aria-selected', 'true');
  await expect(rootThreadTab).toHaveAttribute('aria-selected', 'true');
  await expect(flint).toHaveAttribute('data-agent-color', second.color);
  await expect(flint.getByTestId('workspace-agent-mark')).toHaveClass(/bs-agent-family-mark/u);
  await expect(flint.getByTestId('workspace-agent-mark')).toHaveCSS(
    'background-color',
    flintMarkBackground
  );
  await sidebarCedar.getByRole('button', { name: /Expand/ }).click();
  const wrenRow = childRow(grand.callSign);
  await expect(wrenRow).toHaveAttribute('aria-level', '3');
  const wrenButton = wrenRow.getByRole('button', { exact: true, name: `${grand.callSign} Child` });
  await wrenButton.focus();
  await wrenButton.press('Enter');
  await expect(window.getByRole('tab', { exact: true, name: grand.callSign })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(rootThreadTab).toHaveAttribute('aria-selected', 'true');
  const wrenPanel = window.getByRole('tabpanel', { exact: true, name: grand.callSign });
  await expect(wrenPanel.getByText(SAVED.grand, { exact: true })).toBeVisible();
  await expect(wrenPanel.getByRole('navigation', { name: 'Conversation ancestry' })).toContainText(
    first.callSign
  );
  await wrenPanel.getByRole('button', { exact: true, name: first.callSign }).click();
  await expect(cedar).toHaveAttribute('aria-selected', 'true');
  await expect(cedar).toBeFocused();
  await expect(rootThreadTab).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(() => cedarViewport.evaluate((element) => element.scrollTop))
    .toBeLessThanOrEqual(1);
  await expect(rootComposer).toHaveValue('UNSENT_PARENT_DRAFT_1724');
  // Open an existing child's sidebar row while another root owns the workspace.
  await threadRow(OTHER_TITLE).click();
  await expect(cedar).toHaveCount(0);
  await sidebarCedar.getByRole('button', { exact: true, name: `${first.callSign} Child` }).click();
  await expect(cedar).toHaveAttribute('aria-selected', 'true');
  await expect(rootComposer).toHaveValue('UNSENT_PARENT_DRAFT_1724');
  // The other root's saved workspace never gains the child's tab.
  await expect.poll(async () => (await readSavedChildTabs(userDataDir, other))?.open).toEqual([]);
  // Opening the restored children executed nothing at the provider boundary.
  expect(modelCalls()).toBe(settledModelCalls);
  await window.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('restored-child-workspace.png'),
  });
  await expect(window.getByText(SAVED.first, { exact: true })).toBeVisible();
  await testInfo.attach('restored-child-workspace', {
    contentType: 'image/png',
    path: testInfo.outputPath('restored-child-workspace.png'),
  });

  // Delete through the actual sidebar action, then reload. The other root and
  // its workspace survive; stale saved child tabs may never revive work.
  await rootRow.getByRole('button', { name: `Thread actions ${ROOT_TITLE}` }).click();
  await window.getByRole('button', { exact: true, name: 'Delete…' }).click();
  await window.getByRole('button', { name: `Confirm delete thread ${ROOT_TITLE}` }).click();
  await expect(rootRow).toHaveCount(0);
  await expect(cedar).toHaveCount(0);
  await expect(flint).toHaveCount(0);
  await expect(window.getByRole('tab', { exact: true, name: grand.callSign })).toHaveCount(0);
  // The host deleted the root with its whole delegation tree; the other root stays.
  const held = async () =>
    Object.fromEntries(
      await Promise.all(
        [root, first.threadId, second.threadId, grand.threadId, other].map(
          async (threadId) => [threadId, await hostThreadExists(userDataDir, threadId)] as const
        )
      )
    );
  expect(await held()).toEqual({
    [first.threadId]: false,
    [grand.threadId]: false,
    [other]: true,
    [root]: false,
    [second.threadId]: false,
  });

  await window.reload();
  await mockFileSystemOperations(window);
  await ensureAssistantShellVisible(window);
  await expect(threadRow(OTHER_TITLE)).toBeVisible();
  await expect(window.getByRole('tab', { exact: true, name: first.callSign })).toHaveCount(0);
  await expect(
    window.getByRole('button', { exact: true, name: `${first.callSign} Child` })
  ).toHaveCount(0);
  // Deleted children never execute.
  expect(modelCalls()).toBe(settledModelCalls);
});
