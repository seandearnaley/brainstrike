import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

const CANVAS_TITLE = 'Background search report';
const CANVAS_HTML = '<!doctype html><html><body><h1>Background search report</h1></body></html>';

// The provider shim scripts only the external model. Electron's assistant host,
// background children, read permissions, native approval and canvas DB stay real.
test.fixme(
  'root creates a canvas after two approved background Explorer reads',
  { annotation: { description: 'BST-1956', type: 'quarantine' } },
  async ({ electron }, testInfo) => {
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
      const assistantPosts: { body: unknown; path: string }[] = [];
      window.on('pageerror', (error) => unhandledErrors.push(error.message));
      window.on('request', (request) => {
        const requestPath = new URL(request.url()).pathname;
        if (
          request.method() !== 'POST' ||
          (requestPath !== '/assistant' && requestPath !== '/assistant/decide')
        ) {
          return;
        }
        assistantPosts.push({ body: request.postDataJSON(), path: requestPath });
      });
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

      const initialPost = assistantPosts.find(
        ({ path: requestPath }) => requestPath === '/assistant'
      );
      const rootMemory = (
        initialPost?.body as
          | { data?: { memory?: { resourceId?: unknown; threadId?: unknown } } }
          | undefined
      )?.data?.memory;
      if (typeof rootMemory?.resourceId !== 'string' || typeof rootMemory.threadId !== 'string') {
        throw new Error('Initial assistant POST lacked root ownership coordinates');
      }
      const rootCoordinates = {
        resourceId: rootMemory.resourceId,
        threadId: rootMemory.threadId,
      };
      const rows = await window.evaluate(async ({ resourceId, threadId }) => {
        const api = (
          globalThis as {
            electronAPI?: {
              db?: {
                query?: (
                  sql: string,
                  params?: readonly unknown[]
                ) => Promise<{ rows: Record<string, unknown>[] }>;
              };
            };
          }
        ).electronAPI;
        if (!api?.db?.query) {
          throw new Error('Native database bridge unavailable');
        }
        return (
          await api.db.query(
            `SELECT canvas.title, canvas.html, canvas.version,
        canvas.thread_id AS "threadId", canvas.resource_id AS "resourceId",
        (child.thread_id = child.root_thread_id AND child.parent_thread_id IS NULL) AS "isRootOwner"
        FROM brainstrike_canvas_versions canvas
        LEFT JOIN brainstrike_delegated_conversations child ON child.thread_id = canvas.thread_id
        WHERE canvas.thread_id = $1 AND canvas.resource_id = $2
        ORDER BY canvas.version DESC`,
            [threadId, resourceId]
          )
        ).rows;
      }, rootCoordinates);
      expect(rows).toEqual([
        {
          html: CANVAS_HTML,
          isRootOwner: true,
          resourceId: expect.any(String),
          threadId: expect.any(String),
          title: CANVAS_TITLE,
          version: 1,
        },
      ]);
      expect(
        provider.transcript().filter((turn) => turn.decision === 'tool:agent-explore+agent-explore')
      ).toHaveLength(1);
      expect(
        provider.transcript().filter((turn) => turn.decision === 'tool:brainstrike_manageCanvas')
      ).toHaveLength(1);
      const canvasActions = assistantPosts.flatMap(({ body, path: requestPath }) => {
        if (!(body && typeof body === 'object' && !Array.isArray(body))) {
          return [];
        }
        const payload = body as Record<string, unknown>;
        const runConfig = payload['runConfig'];
        const custom =
          runConfig && typeof runConfig === 'object' && 'custom' in runConfig
            ? runConfig.custom
            : undefined;
        const possibleAction =
          custom && typeof custom === 'object' && 'brainstrikeToolApproval' in custom
            ? custom.brainstrikeToolApproval
            : payload['action'];
        if (
          !(
            possibleAction &&
            typeof possibleAction === 'object' &&
            'toolName' in possibleAction &&
            'toolCallId' in possibleAction
          ) ||
          possibleAction.toolName !== 'brainstrike.manageCanvas'
        ) {
          return [];
        }
        return [
          {
            path: requestPath,
            pausedMessageId: payload['pausedMessageId'],
            toolCallId: possibleAction.toolCallId,
          },
        ];
      });
      expect(canvasActions).toHaveLength(2);
      expect(canvasActions[0]).toEqual({
        path: '/assistant/decide',
        pausedMessageId: undefined,
        toolCallId: canvasActions[1]?.toolCallId,
      });
      const canvasAction = canvasActions[1];
      expect(canvasAction?.path).toBe('/assistant');
      expect(canvasAction?.pausedMessageId).toEqual(expect.any(String));
      expect(canvasAction?.toolCallId).toEqual(expect.any(String));
      if (
        !(
          canvasAction &&
          typeof canvasAction.pausedMessageId === 'string' &&
          typeof canvasAction.toolCallId === 'string' &&
          typeof rows[0]?.['threadId'] === 'string'
        )
      ) {
        throw new Error('Canvas approval request lacked its root ownership coordinates');
      }
      const owner = await window.evaluate(
        async ({ pausedMessageId, threadId, toolCallId }) => {
          const api = (
            globalThis as {
              electronAPI?: {
                db?: {
                  query?: (
                    sql: string,
                    params?: readonly unknown[]
                  ) => Promise<{ rows: Record<string, unknown>[] }>;
                };
              };
            }
          ).electronAPI;
          if (!api?.db?.query) {
            throw new Error('Native database bridge unavailable');
          }
          const [native, transient, durable] = await Promise.all([
            api.db.query(
              `SELECT id FROM mastra_messages
           WHERE thread_id = $1 AND role = 'assistant' AND content::text LIKE $2`,
              [threadId, `%${toolCallId}%`]
            ),
            api.db.query(
              `SELECT parent_id AS "parentId" FROM brainstrike_assistant_message_parents
           WHERE thread_id = $1 AND message_id = $2`,
              [threadId, pausedMessageId]
            ),
            api.db.query('SELECT id FROM mastra_messages WHERE thread_id = $1 AND id = $2', [
              threadId,
              pausedMessageId,
            ]),
          ]);
          return { durable: durable.rows, native: native.rows, transient: transient.rows };
        },
        {
          pausedMessageId: canvasAction.pausedMessageId,
          threadId: rows[0]['threadId'],
          toolCallId: canvasAction.toolCallId,
        }
      );
      expect(owner.native).toHaveLength(1);
      expect(owner.durable).toEqual([{ id: canvasAction.pausedMessageId }]);
      expect(owner.transient).toEqual([{ parentId: expect.any(String) }]);
      expect(owner.native[0]?.['id']).toBe(canvasAction.pausedMessageId);
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
  }
);
