// Keep foreground decisions covered explicitly; delegated-worker-write covers background mode.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readHostThreadTree, withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import {
  ensureActivityExpanded,
  ensureAssistantShellVisible,
  ensureMockWorkspaceOpen,
} from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

// Script only the external model provider. Assistant HTTP, native permission,
// delegation, workspace reads, persistence and shared child controls are real.
const FOLLOW_UP_PROMPT = 'FOLLOW_UP_1720: What did Explorer report?';
const FOLLOW_UP_REPLY = 'FOLLOW_UP_ON_TERRA_1720';

test('approves the exact reloaded child through the shared workspace @smoke', async ({
  electron,
}, testInfo) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-child-control-'));
  await writeFile(path.join(workspace, 'evidence.txt'), 'CHILD_EVIDENCE_1720');
  const observed = { childRead: false, parentResult: false };
  const executedConfigurations: { body: unknown; followUp: boolean; isParent: boolean }[] = [];
  const provider = await startModelProviderShim(({ messages, toolNames, requestBody }) => {
    // Children now advertise delegation too; identify the actual root task.
    const lastUser = JSON.stringify(
      messages
        .filter(
          (message) =>
            message && typeof message === 'object' && 'role' in message && message.role === 'user'
        )
        .at(-1)
    );
    const isParent = lastUser.includes('Delegate to Explorer to read evidence.txt.');
    const followUp = lastUser.includes(FOLLOW_UP_PROMPT);
    const history = JSON.stringify(messages);
    if (toolNames.length > 0) {
      executedConfigurations.push({ body: requestBody, followUp, isParent });
    }
    if (followUp) {
      return { finalText: FOLLOW_UP_REPLY };
    }
    if (isParent && history.includes('CHILD_READ_COMPLETE_1720')) {
      observed.parentResult = true;
    }
    if (!isParent && history.includes('CHILD_EVIDENCE_1720')) {
      observed.childRead = true;
    }
    return isParent
      ? {
          finalText: 'PARENT_RECEIVED_CHILD_1720',
          toolCall: {
            arguments: {
              _background: { enabled: false },
              prompt: 'Read evidence.txt and report its marker.',
            },
            name: 'agent-explore',
          },
        }
      : {
          finalText: 'CHILD_READ_COMPLETE_1720',
          toolCall: { arguments: { path: 'evidence.txt' }, name: 'brainstrike_readWorkspaceFile' },
        };
  });
  // A reload must not call the model. The host child view reads the provider's
  // model metadata on mount, which is not a model call, so count generations.
  const modelCalls = (): number => provider.requests().length;
  const previousUrl = process.env['OPENROUTER_BASE_URL'];
  const previousKey = process.env['BRAINSTRIKE_OPENROUTER_API_KEY'];
  const previousRoot = process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'];
  process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = workspace;
  process.env['OPENROUTER_BASE_URL'] = provider.baseUrl;
  process.env['BRAINSTRIKE_OPENROUTER_API_KEY'] = 'isolated-child-provider-key';
  try {
    const window = await electron.ensureWindow();
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window, {
      compositeModelKey: 'openrouter::anthropic/claude-sonnet-4.6',
      provider: 'openrouter',
    });
    await enableAssistantCatalogModel(window, 'openrouter::anthropic/claude-sonnet-4.6');
    await new HomePage(window).openSettings();
    await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
    await window
      .getByRole('combobox', { exact: true, name: 'Read permission' })
      .selectOption('ask');
    await ensureAssistantShellVisible(window);
    const root = window.getByRole('region', { exact: true, name: 'Assistant' });
    // The host reads OpenRouter reasoning controls from model metadata; the shim
    // serves the one recorded identity (Sonnet 4.6, efforts low..max).
    await root.getByTestId('composer-effort-trigger').click();
    await window.getByRole('slider', { name: 'Reasoning effort' }).press('End');
    await window.keyboard.press('Escape');
    await root
      .getByRole('textbox', { name: 'Message input' })
      .fill('Delegate to Explorer to read evidence.txt.');
    await root.getByRole('button', { exact: true, name: 'Send' }).click();
    // A host root lists its tree's waiting approvals in its strip; the child answers its own.
    await expect(root.getByRole('button', { name: 'Review 1 pending approval' })).toBeVisible();
    await expect(root.getByText('Waiting for approval', { exact: true })).toHaveCount(0);
    // The delegation card is inside the root's activity, collapsed by default.
    await ensureActivityExpanded(root);
    const openChild = root.getByRole('button', { name: /Open .* conversation/ });
    await expect(openChild).toBeVisible();
    await openChild.click();
    const childTab = window
      .getByRole('tablist', { name: 'Workspace tabs' })
      .getByRole('tab', { selected: true });
    await expect(childTab).toHaveText(/^[A-Z][a-z]+-[a-f0-9]{6}$/);
    const childName = (await childTab.innerText()).trim();
    const child = window.getByRole('region', { exact: true, name: childName });
    await expect(
      child.getByRole('button', { exact: true, name: 'Approve brainstrike.readWorkspaceFile' })
    ).toBeVisible();
    const firstChild = executedConfigurations.find((entry) => !entry.isParent);
    expect(firstChild?.body).toMatchObject({
      model: 'anthropic/claude-sonnet-4.6',
      reasoning: { effort: 'max' },
    });
    // Change the parent's actual model control while its child decision is pending.
    await root.getByTestId('composer-model-menu-trigger').click();
    const modelDialog = window.getByRole('dialog', { name: 'Choose a model' });
    await modelDialog.getByRole('combobox').fill('GPT-5.6 Terra');
    const terra = modelDialog
      .getByRole('option', { name: /^GPT-5\.6 Terra/u })
      .filter({ hasText: 'OpenRouter' });
    await expect(terra).toBeVisible();
    await terra.click();
    await expect(root.getByTestId('composer-model-menu-trigger')).toContainText('GPT-5.6 Terra');
    // ADR-0019: the host commits the pick as the root thread's selection while the
    // root's run is still paused on its child, so the reload below reads it back.
    const rootThread = (await readHostThreadTree(electron.getUserDataDir())).find(
      ({ parentThreadId }) => parentThreadId === undefined
    );
    if (!rootThread) {
      throw new Error('The host committed no root thread');
    }
    await expect
      .poll(async () =>
        withAppHost(electron.getUserDataDir(), async (client) => {
          const { selection } = await client.request('thread/selection/read', {
            threadId: rootThread.threadId,
          });
          return selection?.modelId;
        })
      )
      .toBe('openrouter::openai/gpt-5.6-terra');
    const pausedRequests = modelCalls();
    await window.reload();
    await configureAssistantProvider(window, {
      compositeModelKey: 'openrouter::openai/gpt-5.6-terra',
      provider: 'openrouter',
    });
    await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.6-terra');
    await ensureAssistantShellVisible(window);
    await expect(
      child.getByRole('button', { exact: true, name: 'Approve brainstrike.readWorkspaceFile' })
    ).toBeVisible();
    expect(modelCalls()).toBe(pausedRequests);
    // The recreated sidebar must recover the same native pending decision without
    // relying on a live-stream publication from before the renderer reload.
    const sidebarRoot = window
      .getByRole('row')
      .filter({ has: window.getByTestId('thread-row') })
      .first();
    await sidebarRoot.getByRole('button', { name: /Expand/u }).click();
    const pendingSidebarChild = window.getByRole('button', {
      exact: true,
      name: `${childName} Needs input`,
    });
    await expect(pendingSidebarChild).toBeVisible();
    expect(modelCalls()).toBe(pausedRequests);
    await child
      .getByRole('button', { exact: true, name: 'Approve brainstrike.readWorkspaceFile' })
      .click();
    await expect(child.getByText('CHILD_READ_COMPLETE_1720', { exact: true })).toBeVisible();
    await expect(root.getByText('PARENT_RECEIVED_CHILD_1720', { exact: true })).toBeVisible();
    expect(observed).toEqual({ childRead: true, parentResult: true });
    // The host committed the child's one approval, answered once, and its run completed.
    const childLog = (await readHostThreadTree(electron.getUserDataDir())).find(
      ({ parentThreadId }) => parentThreadId
    );
    const childEvents = (childLog?.rows ?? []).map(({ event }) => event);
    expect(
      childEvents.flatMap((event) =>
        event.type === 'interaction.requested' ? [event.toolCatalogId ?? event.toolId] : []
      )
    ).toEqual(['brainstrike.readWorkspaceFile']);
    expect(
      childEvents.flatMap((event) =>
        event.type === 'interaction.responded' && 'decision' in event ? [event.decision] : []
      )
    ).toEqual(['approve']);
    expect(
      childEvents.flatMap((event) => (event.type === 'run.finished' ? [event.outcome] : []))
    ).toEqual(['completed']);
    const childExecutions = executedConfigurations.filter(
      (entry) => !(entry.isParent || entry.followUp)
    );
    expect(childExecutions).toHaveLength(2);
    expect(childExecutions[1]?.body).toMatchObject({
      model: 'anthropic/claude-sonnet-4.6',
      reasoning: { effort: 'max' },
    });
    // An admitted run's selection is frozen (ADR-0009/0010): the host kept the
    // parent's run alive across the reload, so it finishes on the model it was
    // admitted with. (Legacy switched here only because a reload killed the run
    // and the renderer restarted it with the current composer.) The pick is the
    // thread's committed selection (ADR-0019), so the next user message uses it.
    expect(executedConfigurations.filter((entry) => entry.isParent).at(-1)?.body).toMatchObject({
      model: 'anthropic/claude-sonnet-4.6',
      reasoning: { effort: 'max' },
    });
    await expect(root.getByTestId('composer-model-menu-trigger')).toContainText('GPT-5.6 Terra');
    await root.getByRole('textbox', { name: 'Message input' }).fill(FOLLOW_UP_PROMPT);
    await root.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(root.getByText(FOLLOW_UP_REPLY, { exact: true })).toBeVisible();
    const followUps = executedConfigurations.filter((entry) => entry.followUp);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.body).toMatchObject({ model: 'openai/gpt-5.6-terra' });
    await expect(child.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
    const completedRequests = modelCalls();
    // The tab ✕ is a mouse-only, aria-hidden sibling of the tab that shows on
    // hover (TabStrip contract), so point at the tab first.
    await window.getByRole('tab', { exact: true, name: childName }).hover();
    await window
      .getByRole('button', { exact: true, includeHidden: true, name: `Close ${childName}` })
      .click();
    await testInfo.attach('activity-before-reopen', {
      body: await root.innerText(),
      contentType: 'text/plain',
    });
    const delegationGroup = root
      .getByTestId('assistant-activity-group')
      .filter({ hasText: 'Explorer' })
      .last();
    await delegationGroup.getByRole('button', { exact: true, name: 'Expand activity' }).click();
    await testInfo.attach('activity-after-expand', {
      body: await root.innerText(),
      contentType: 'text/plain',
    });
    await delegationGroup.getByRole('button', { name: /Open .* conversation/ }).click();
    await expect(child.getByText('CHILD_READ_COMPLETE_1720', { exact: true })).toBeVisible();
    expect(modelCalls()).toBe(completedRequests);
    await expect(child.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
    const geometry = await child.boundingBox();
    expect(geometry).not.toBeNull();
    expect(geometry?.width).toBeGreaterThan(200);
    expect(geometry?.height).toBeGreaterThan(200);
    await window.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('real-child-control.png'),
    });
  } finally {
    try {
      const ownedProcess = (await electron.ensureContext()).app.process();
      // Resolves once the process has exited.
      await electron.dispose();
      // Soft: a clean exit is required, but its failure never hides the body's.
      expect.soft(ownedProcess.exitCode).toBe(0);
      expect.soft(ownedProcess.signalCode).toBeNull();
    } finally {
      await provider.close();
      if (previousUrl === undefined) {
        delete process.env['OPENROUTER_BASE_URL'];
      } else {
        process.env['OPENROUTER_BASE_URL'] = previousUrl;
      }
      if (previousKey === undefined) {
        delete process.env['BRAINSTRIKE_OPENROUTER_API_KEY'];
      } else {
        process.env['BRAINSTRIKE_OPENROUTER_API_KEY'] = previousKey;
      }
      if (previousRoot === undefined) {
        delete process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'];
      } else {
        process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = previousRoot;
      }
      await rm(workspace, { force: true, recursive: true });
    }
  }
});

// Regression project (not @smoke): the PR smoke lane's 720s global budget is
// already consumed by the 43 smoke cases on main, and this case adds a full
// app launch plus a reload. It runs in the scheduled full-regression lane.
test('sends human input to the active child and reloads its rich conversation', async ({
  electron,
}, testInfo) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-child-input-'));
  await writeFile(path.join(workspace, 'evidence.txt'), 'FOLLOWUP_FILE_EVIDENCE');
  await writeFile(path.join(workspace, 'context.txt'), 'CHILD_MENTION_CONTEXT_1724');
  await mkdir(path.join(workspace, '.brainstrike', 'commands'), { recursive: true });
  await writeFile(
    path.join(workspace, '.brainstrike', 'commands', 'child-evidence.md'),
    'HUMAN_FOLLOWUP_1723\n\n@context.txt'
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let childCalls = 0;
  const childGenerationRequests: unknown[] = [];
  let receivedInput = false;
  let receivedImage = false;
  let receivedFileContext = false;
  const imageBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaGAAAAEEAIFw9selAAAAAElFTkSuQmCC',
    'base64'
  );
  const imageMarker = imageBytes.toString('base64');
  const provider = await startModelProviderShim(({ messages, toolNames, requestBody }) => {
    if (toolNames.length === 0) {
      return { finalText: 'Child input task' };
    }
    const history = JSON.stringify(messages);
    // Native background signals include the child task in a parent user message.
    // The root exposes delegation; Explorer's read-only tool set does not.
    if (toolNames.includes('agent-explore')) {
      if (history.includes('CHILD_IDLE_APPROVAL_COMPLETE')) {
        return { finalText: 'PARENT_IDLE_APPROVAL_OUTCOME' };
      }
      if (history.includes('CHILD_IDLE_CONTINUATION_RECEIVED')) {
        return { finalText: 'PARENT_IDLE_CONTINUATION_OUTCOME' };
      }
      if (history.includes('CHILD_FOLLOWUP_RECEIVED')) {
        return { finalText: 'PARENT_FOLLOWUP_OUTCOME' };
      }
      if (history.includes('Background task started.')) {
        return { finalText: 'Parent continues while the child reads.' };
      }
      return {
        finalText: 'Parent continues while the child reads.',
        toolCall: {
          arguments: {
            _background: { enabled: true },
            prompt: 'CHILD_ACTIVE_INPUT_TASK: read evidence.txt and report its marker.',
          },
          name: 'agent-explore',
        },
      };
    }
    childCalls += 1;
    childGenerationRequests.push(requestBody);
    if (childCalls === 1) {
      entered.resolve();
    }
    if (history.includes('HUMAN_IDLE_APPROVAL_1723')) {
      return {
        finalText: 'CHILD_IDLE_APPROVAL_COMPLETE',
        toolCall: { arguments: { path: 'evidence.txt' }, name: 'brainstrike_readWorkspaceFile' },
      };
    }
    if (childCalls === 3 && history.includes(imageMarker)) {
      return { finalText: 'CHILD_IDLE_CONTINUATION_RECEIVED' };
    }
    if (history.includes('HUMAN_FOLLOWUP_1723')) {
      receivedInput = true;
      receivedImage = history.includes(imageMarker);
      receivedFileContext = messages.some(
        (message) =>
          message &&
          typeof message === 'object' &&
          'role' in message &&
          message.role === 'system' &&
          JSON.stringify(message).includes('CHILD_MENTION_CONTEXT_1724')
      );
      return { finalText: 'CHILD_FOLLOWUP_RECEIVED' };
    }
    return {
      ...(childCalls === 1 ? { beforeToolFinish: release.promise } : {}),
      finalText: 'CHILD_MISSED_INPUT',
      toolCall: { arguments: { path: 'evidence.txt' }, name: 'brainstrike_readWorkspaceFile' },
    };
  });
  // A reload must not call the model. The host child view reads the provider's
  // model metadata on mount, which is not a model call, so count generations.
  const modelCalls = (): number => provider.requests().length;
  const environment = {
    BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
    BRAINSTRIKE_OPENROUTER_API_KEY: 'isolated-child-input-key',
    OPENROUTER_BASE_URL: provider.baseUrl,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  try {
    const window = await electron.ensureWindow();
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window, {
      compositeModelKey: 'openrouter::anthropic/claude-sonnet-4.6',
      provider: 'openrouter',
    });
    await enableAssistantCatalogModel(window, 'openrouter::anthropic/claude-sonnet-4.6');
    await new HomePage(window).openSettings();
    await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
    await window
      .getByRole('combobox', { exact: true, name: 'Read permission' })
      .selectOption('allow');
    await ensureAssistantShellVisible(window);
    const root = window.getByRole('region', { exact: true, name: 'Assistant' });
    await root
      .getByRole('textbox', { name: 'Message input' })
      .fill('ROOT_ACTIVE_INPUT_TASK: delegate to Explorer to read evidence.txt.');
    await root.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect.poll(() => childCalls).toBeGreaterThan(0);
    await entered.promise;
    await expect(
      root.getByText('Parent continues while the child reads.', { exact: true }),
      JSON.stringify(provider.transcript())
    ).toBeVisible();
    await root.getByRole('button', { exact: true, name: 'Expand activity' }).first().click();
    await root.getByRole('button', { name: /Open .* conversation/ }).click();
    const childTab = window
      .getByRole('tablist', { name: 'Workspace tabs' })
      .getByRole('tab', { selected: true });
    await expect(childTab).toHaveText(/^[A-Z][a-z]+-[a-f0-9]{6}$/);
    const childName = (await childTab.innerText()).trim();
    const child = window.getByRole('region', { exact: true, name: childName });
    const input = child.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeEnabled();
    await input.fill('/child-evidence');
    await child.getByRole('option', { exact: true, name: 'child-evidence' }).click();
    await expect(input).toHaveValue(/HUMAN_FOLLOWUP_1723/u);
    await expect(input).toHaveValue(/:file\[context\.txt\]/u);
    const activeChooser = window.waitForEvent('filechooser');
    await child.getByRole('button', { exact: true, name: 'Attach image' }).click();
    await (await activeChooser).setFiles({
      buffer: imageBytes,
      mimeType: 'image/png',
      name: 'evidence.png',
    });
    await child.getByRole('button', { exact: true, name: 'Send to child' }).click();
    await expect(input).toHaveValue('');
    release.resolve();
    await expect(child.getByText('HUMAN_FOLLOWUP_1723', { exact: true })).toBeVisible();
    await expect(child.getByText('CHILD_FOLLOWUP_RECEIVED', { exact: true })).toBeVisible();
    await expect(root.getByText('PARENT_FOLLOWUP_OUTCOME', { exact: true })).toBeVisible();
    expect(receivedInput).toBe(true);
    expect(receivedImage).toBe(true);
    expect(receivedFileContext).toBe(true);
    await expect(child.locator('img[src^="data:image/png"]')).toHaveCount(1);
    expect(childCalls).toBe(2);
    // The host ended the active child run after its step and committed the input
    // as the child's next run; only that run's answer reached the parent.
    const tree = await readHostThreadTree(electron.getUserDataDir());
    const childPrompts = (tree.find(({ parentThreadId }) => parentThreadId)?.rows ?? []).flatMap(
      ({ event }) => (event.type === 'run.started' ? [event.prompt] : [])
    );
    expect(childPrompts).toHaveLength(2);
    expect(childPrompts[1]).toContain('HUMAN_FOLLOWUP_1723');
    const completedRequests = modelCalls();
    const httpBeforeReload = provider.requestCount();
    const metadataBeforeReload = provider.servedMetadata().length;
    const refusalsBeforeReload = provider.refusals().length;
    await window.reload();
    await ensureAssistantShellVisible(window);
    await expect(child.getByText('HUMAN_FOLLOWUP_1723', { exact: true })).toBeVisible();
    await expect(child.getByText('CHILD_FOLLOWUP_RECEIVED', { exact: true })).toBeVisible();
    expect(modelCalls()).toBe(completedRequests);
    // Evidence for what a reload asks the provider, beside the model calls it must not make.
    const reloadRequests = {
      http: provider.requestCount() - httpBeforeReload,
      metadata: provider.servedMetadata().slice(metadataBeforeReload),
      // Requests the shim refused instead of answering, with their routes.
      refused: provider
        .refusals()
        .slice(refusalsBeforeReload)
        .map(({ method, reason, route }) => ({ method, reason, route })),
    };
    console.log(`reload-provider-requests ${JSON.stringify(reloadRequests)}`);
    await testInfo.attach('reload-provider-requests', {
      body: JSON.stringify(reloadRequests),
      contentType: 'application/json',
    });
    await expect(input).toBeEnabled();
    await child.getByTestId('composer-effort-trigger').click();
    await window.getByRole('slider', { name: 'Reasoning effort' }).press('End');
    await window.keyboard.press('Escape');
    await expect(child.getByTestId('composer-effort-trigger')).toContainText('Max');
    const idleChooser = window.waitForEvent('filechooser');
    await child.getByRole('button', { exact: true, name: 'Attach image' }).click();
    await (await idleChooser).setFiles({
      buffer: imageBytes,
      mimeType: 'image/png',
      name: 'idle-evidence.png',
    });
    await child.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(input).toHaveValue('');
    await expect(child.locator('img[src^="data:image/png"]')).toHaveCount(2);
    await expect(
      child.getByText('CHILD_IDLE_CONTINUATION_RECEIVED', { exact: true })
    ).toBeVisible();
    await expect(root.getByText('PARENT_IDLE_CONTINUATION_OUTCOME', { exact: true })).toBeVisible();
    expect(childCalls).toBe(3);
    expect(childGenerationRequests[2]).toMatchObject({ reasoning: { effort: 'max' } });
    const continuedRequests = modelCalls();
    await window.reload();
    await ensureAssistantShellVisible(window);
    await expect(child.locator('img[src^="data:image/png"]')).toHaveCount(2);
    await expect(
      child.getByText('CHILD_IDLE_CONTINUATION_RECEIVED', { exact: true })
    ).toBeVisible();
    expect(modelCalls()).toBe(continuedRequests);
    await new HomePage(window).openSettings();
    await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
    await window
      .getByRole('combobox', { exact: true, name: 'Read permission' })
      .selectOption('ask');
    await ensureAssistantShellVisible(window);
    await child.getByTestId('composer-effort-trigger').click();
    await window.getByRole('slider', { name: 'Reasoning effort' }).press('End');
    await window.keyboard.press('Escape');
    await input.fill('HUMAN_IDLE_APPROVAL_1723');
    await child.getByRole('button', { exact: true, name: 'Send' }).click();
    const approve = child.getByRole('button', {
      exact: true,
      name: 'Approve brainstrike.readWorkspaceFile',
    });
    await expect(approve).toBeVisible();
    expect(childCalls).toBe(4);
    expect(childGenerationRequests[3]).toMatchObject({ reasoning: { effort: 'max' } });
    // A draft for a future child run must not mutate the suspended invocation.
    await child.getByTestId('composer-effort-trigger').click();
    await window.getByRole('slider', { name: 'Reasoning effort' }).press('Home');
    await window.keyboard.press('Escape');
    const suspendedRequests = modelCalls();
    await window.reload();
    await ensureAssistantShellVisible(window);
    await expect(approve).toBeVisible();
    expect(modelCalls()).toBe(suspendedRequests);
    await approve.click();
    await expect(child.getByText('CHILD_IDLE_APPROVAL_COMPLETE', { exact: true })).toBeVisible();
    await expect(root.getByText('PARENT_IDLE_APPROVAL_OUTCOME', { exact: true })).toBeVisible();
    expect(childCalls).toBe(5);
    expect(childGenerationRequests[4]).toMatchObject({ reasoning: { effort: 'max' } });
    const approvedRequests = modelCalls();
    await window.reload();
    await ensureAssistantShellVisible(window);
    await expect(child.getByText('CHILD_IDLE_APPROVAL_COMPLETE', { exact: true })).toBeVisible();
    await expect(approve).toHaveCount(0);
    expect(modelCalls()).toBe(approvedRequests);
    await window.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('child-followup-reloaded.png'),
    });
  } finally {
    release.resolve();
    try {
      const process = (await electron.ensureContext()).app.process();
      // Resolves once the process has exited.
      await electron.dispose();
      // Soft: a clean exit is required, but its failure never hides the body's.
      expect.soft(process.exitCode).toBe(0);
      expect.soft(process.signalCode).toBeNull();
    } finally {
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
});
