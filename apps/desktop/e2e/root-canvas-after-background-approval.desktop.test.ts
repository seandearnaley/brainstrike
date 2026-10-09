import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

const CANVAS_TITLE = 'Background search report';
const CANVAS_HTML = '<!doctype html><html><body><h1>Background search report</h1></body></html>';

// The provider shim scripts only the external model. Electron's assistant host,
// background children, read permissions, native approval and canvas DB stay real.
test('root creates a canvas after two approved background Explorer reads', async ({
  electron,
}, testInfo) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-root-canvas-'));
  await writeFile(path.join(workspace, 'first.txt'), 'FIRST_EXPLORER_EVIDENCE');
  await writeFile(path.join(workspace, 'second.txt'), 'SECOND_EXPLORER_EVIDENCE');
  let requestedCanvasLoad = false;
  let requestedCanvasCreate = false;
  const provider = await startModelProviderShim(({ messages, toolNames }) => {
    if (toolNames.length === 0) {
      return { finalText: CANVAS_TITLE };
    }
    const userMessages = messages.filter(
      (message) =>
        message && typeof message === 'object' && 'role' in message && message.role === 'user'
    );
    const isRootWakeup = userMessages.some((message) =>
      JSON.stringify(message).includes('Background invocations of this turn')
    );
    const task = JSON.stringify(
      userMessages.filter(
        (message) => !JSON.stringify(message).includes('Background invocations of this turn')
      )
    );
    if (task.includes('EXPLORER_FIRST_TASK')) {
      return {
        finalText: 'FIRST_EXPLORER_DONE',
        toolCall: { arguments: { path: 'first.txt' }, name: 'brainstrike_readWorkspaceFile' },
      };
    }
    if (task.includes('EXPLORER_SECOND_TASK')) {
      return {
        finalText: 'SECOND_EXPLORER_DONE',
        toolCall: { arguments: { path: 'second.txt' }, name: 'brainstrike_readWorkspaceFile' },
      };
    }
    if (isRootWakeup) {
      if (!(requestedCanvasLoad || toolNames.includes('brainstrike_manageCanvas'))) {
        if (!toolNames.includes('load_tool')) {
          throw new Error('Root continuation cannot load manageCanvas');
        }
        requestedCanvasLoad = true;
        return {
          finalText: 'ROOT_CANVAS_CREATED',
          // This stateful script advances explicitly: on the host the loaded tool is
          // called in the same run, after the load's own result (as AT-04 scripts it).
          ignorePriorToolResults: true,
          toolCall: {
            arguments: { toolName: 'brainstrike_manageCanvas' },
            name: 'load_tool',
          },
        };
      }
      if (requestedCanvasCreate) {
        return { finalText: 'ROOT_CANVAS_CREATED' };
      }
      if (!toolNames.includes('brainstrike_manageCanvas')) {
        throw new Error('Root continuation did not advertise loaded manageCanvas');
      }
      requestedCanvasCreate = true;
      return {
        finalText: 'ROOT_CANVAS_CREATED',
        ignorePriorToolResults: true,
        toolCall: {
          arguments: {
            action: 'create',
            canvasId: 'provider-ignored-canvas-id',
            html: CANVAS_HTML,
            newString: '',
            oldString: '.',
            title: CANVAS_TITLE,
          },
          name: 'brainstrike_manageCanvas',
        },
      };
    }
    if (!toolNames.includes('agent-explore')) {
      throw new Error('Root did not advertise Explorer');
    }
    return {
      finalText: 'ROOT_WAITING_FOR_EXPLORERS',
      toolCalls: [
        {
          arguments: {
            _background: { enabled: true },
            prompt: 'EXPLORER_FIRST_TASK: read first.txt and report its evidence.',
          },
          name: 'agent-explore',
        },
        {
          arguments: {
            _background: { enabled: true },
            prompt: 'EXPLORER_SECOND_TASK: read second.txt and report its evidence.',
          },
          name: 'agent-explore',
        },
      ],
    };
  });
  const environment = {
    BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
    BRAINSTRIKE_OPENROUTER_API_KEY: 'isolated-root-canvas-key',
    OPENROUTER_BASE_URL: provider.baseUrl,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  const testFailures: unknown[] = [];
  const cleanupFailures: unknown[] = [];
  try {
    const window = await electron.ensureWindow();
    const unhandledErrors: string[] = [];
    window.on('pageerror', (error) => unhandledErrors.push(error.message));
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
    await window.getByTestId('permission-policy-edit').selectOption('ask');
    await ensureAssistantShellVisible(window);
    const root = window.getByRole('region', { exact: true, name: 'Assistant' });
    await root
      .getByRole('textbox', { name: 'Message input' })
      .fill('Ask two Explorers to read their evidence, then create the report canvas.');
    await root.getByRole('button', { exact: true, name: 'Send' }).click();

    // The category grant approves the first leaf and releases its parked sibling.
    await expect(root.getByTestId('approval-strip-count-read')).toContainText('2 reads');
    await root.getByTestId('approval-strip-grant-read').click();
    const canvasApproval = root.getByRole('button', {
      exact: true,
      name: 'Approve brainstrike.manageCanvas',
    });
    await expect(canvasApproval).toBeVisible();
    await canvasApproval.click();
    await expect(root.getByText('ROOT_CANVAS_CREATED', { exact: true })).toBeVisible();

    // The root thread is the one the host lists both Explorers under.
    const tree = await readHostThreadTree(electron.getUserDataDir());
    const rootLog = tree.find(
      ({ parentThreadId, threadId }) =>
        parentThreadId === undefined && tree.some((log) => log.parentThreadId === threadId)
    );
    if (!rootLog) {
      throw new Error('No root thread delegated the Explorers');
    }
    expect(tree.filter(({ parentThreadId }) => parentThreadId === rootLog.threadId)).toHaveLength(
      2
    );
    // The canvas is the ROOT thread's committed tool state: one version, never a child's.
    const canvases = (log: (typeof tree)[number]) =>
      log.rows.flatMap(({ event }) =>
        event.type === 'tool.state.updated' && event.key.startsWith('brainstrike.manageCanvas/')
          ? [event.value]
          : []
      );
    expect(canvases(rootLog)).toMatchObject([
      { html: CANVAS_HTML, title: CANVAS_TITLE, version: 1 },
    ]);
    for (const log of tree.filter(({ parentThreadId }) => parentThreadId === rootLog.threadId)) {
      expect(canvases(log)).toEqual([]);
    }
    expect(
      provider.transcript().filter((turn) => turn.decision === 'tool:agent-explore+agent-explore')
    ).toHaveLength(1);
    expect(
      provider.transcript().filter((turn) => turn.decision === 'tool:brainstrike_manageCanvas')
    ).toHaveLength(1);
    // One canvas pause on the root, answered once and executed once, in the run that asked.
    const events = rootLog.rows.map(({ event }) => event);
    const requested = events.flatMap((event) =>
      event.type === 'interaction.requested' &&
      (event.toolCatalogId ?? event.toolId) === 'brainstrike.manageCanvas'
        ? [event]
        : []
    );
    expect(requested).toHaveLength(1);
    const pause = requested[0];
    if (!pause) {
      throw new Error('The root never paused on its canvas');
    }
    expect(
      events.filter(
        (event) =>
          event.type === 'interaction.responded' && event.interactionId === pause.interactionId
      )
    ).toEqual([expect.objectContaining({ decision: 'approve', runId: pause.runId })]);
    expect(
      events.filter(
        (event) => event.type === 'effect.finished' && event.toolCallId === pause.toolCallId
      )
    ).toEqual([expect.objectContaining({ runId: pause.runId })]);
    expect(unhandledErrors).toEqual([]);
  } catch (error) {
    testFailures.push(error);
    try {
      await testInfo.attach('provider-transcript', {
        body: JSON.stringify(provider.transcript()),
        contentType: 'application/json',
      });
    } catch (attachmentError) {
      testFailures.push(attachmentError);
    }
  } finally {
    for (const key of Object.keys(environment)) {
      try {
        const value = previous[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await electron.dispose();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await provider.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await rm(workspace, { force: true, recursive: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError([...testFailures, ...cleanupFailures], 'Canvas test cleanup failed');
  }
  if (testFailures.length > 1) {
    throw new AggregateError(testFailures, 'Canvas test and diagnostic attachment failed');
  }
  if (testFailures.length === 1) {
    throw testFailures[0];
  }
});
