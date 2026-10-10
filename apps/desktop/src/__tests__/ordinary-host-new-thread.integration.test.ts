// @vitest-environment node

import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  resolveAssistantResilienceConfig,
} from '@brainstrike/agent';
import { createMcpRuntimeClient } from '@brainstrike/agent/mcp-client';
import { startStatefulMcpHostServer } from '@brainstrike/agent/test-fixtures/mcp-host-lifecycle';
import {
  attachAgentHost,
  createProductionHostPlatform,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedToolSequence } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { ASSISTANT_PREFERENCES_STORE_VERSION } from '@brainstrike/app-state/stores/assistant-preferences-store-version';
import {
  DEFAULT_PERMISSION_POLICIES,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { createHostCapabilities } from '@brainstrike/host-capabilities';
import { McpHostRuntime } from '@brainstrike/host-capabilities/mcp/node-host-runtime';
import { openIndexer } from '@brainstrike/indexer';
import { RootLock } from '@brainstrike/state-store';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { _electron, type Page } from 'playwright';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { ensureAssistantShellVisible } from '../../e2e/utils/layout-helpers';
import { createAgentHostToolBindings } from '../agent-host-tool-bindings';
import { createDisposableAppProfile } from './helpers/disposable-app-profile';

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, '../../../..');
const desktop = join(repository, 'apps/desktop');

function readDiagnostics(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const buffer = (
      window as Window & {
        __brainstrikeRendererLogBuffer?: { getRecords(): readonly unknown[] };
      }
    ).__brainstrikeRendererLogBuffer;
    if (!(buffer && window.electronAPI?.db)) {
      throw new Error('Ordinary application diagnostic sources are unavailable');
    }
    const [main, durable] = await Promise.all([
      window.logging.getBufferedLogs(),
      window.electronAPI.db.query(
        'SELECT * FROM brainstrike_diagnostic_events ORDER BY occurred_at'
      ),
    ]);
    return { durable: durable.rows, main, renderer: buffer.getRecords() };
  });
}

function failureEvidence(cause: unknown): unknown {
  return cause instanceof AggregateError
    ? { causes: cause.errors.map(failureEvidence), message: cause.message }
    : cause instanceof Error
      ? {
          cause: cause.cause ? failureEvidence(cause.cause) : undefined,
          message: cause.message,
          stack: cause.stack,
        }
      : String(cause);
}

test(
  'ordinary desktop New Thread attaches the CLI-first production host and renders committed permitted effects',
  async () => {
    const started = performance.now();
    const checkpoint = (phase: string): void => {
      process.stderr.write(
        `${JSON.stringify({ elapsedMs: Math.round(performance.now() - started), phase })}\n`
      );
    };
    const { evidence, root: disposable } = await createDisposableAppProfile(
      'brainstrike-m3-ordinary-'
    );
    const profile = join(disposable, 'profiles', 'm3-owned');
    await mkdir(profile, { recursive: true });
    const path = join(profile, 'permitted.txt');
    const server = await startStatefulMcpHostServer();
    // No OAuth/bearer/Tasks operation is configured for this first connected slice.
    // An unexpected request for an absent capability fails rather than touching the OS.
    const unavailable = async (): Promise<never> => {
      throw new Error('This disposable qualification has no credential or Tasks capability');
    };
    const authority = new McpHostRuntime({
      appUi: 'rich',
      bearerCredentialAuthority: { createFetch: () => unavailable, inspect: unavailable },
      oauthStore: {
        clear: unavailable,
        clearAll: unavailable,
        read: unavailable,
        write: unavailable,
      },
      openExternal: unavailable,
      openTaskStorage: unavailable,
    });
    const indexer = await openIndexer(
      {
        dbPath: join(profile, 'index.sqlite'),
        embedding: { indexMode: 'text-only' },
        rootIds: ['owned-root'],
      },
      { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
    );
    const configuredServerId = parseConfiguredMcpServerId('fixture.ordinary');
    let host: Awaited<ReturnType<typeof startAgentHost>> | undefined;
    let client: Awaited<ReturnType<typeof attachAgentHost>> | undefined;
    let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    let runtimeClient: Awaited<ReturnType<typeof createMcpRuntimeClient>>;
    let originalFailure: unknown;
    const cleanupFailures: unknown[] = [];
    const appOutput: string[] = [];
    const ownedAppPids = new Set<number>();
    const observeApplication = async (current: NonNullable<typeof application>): Promise<void> => {
      current.process().stdout?.on('data', (data: Buffer) => appOutput.push(data.toString()));
      current.process().stderr?.on('data', (data: Buffer) => appOutput.push(data.toString()));
      const metrics = await current.evaluate(({ app }) =>
        app.getAppMetrics().map(({ pid, type }) => ({ pid, type }))
      );
      for (const { pid } of metrics) {
        ownedAppPids.add(pid);
      }
      await writeFile(
        join(evidence, 'owned-app-processes.json'),
        JSON.stringify([...ownedAppPids])
      );
    };
    try {
      await authority.replaceResolvedConfig({
        servers: [
          {
            name: configuredServerId,
            protocol: 'legacy',
            startup: 'automatic',
            transport: 'streamable-http',
            url: server.url,
          },
        ],
      });
      runtimeClient = await createMcpRuntimeClient({ config: undefined, host: authority.host });
      if (!runtimeClient) {
        throw new Error('The actual MCP authority did not connect');
      }
      const discovery = await runtimeClient.listToolsetsWithErrors();
      expect(discovery.errors).toEqual({});
      const tool = discovery.toolsets[configuredServerId]?.['host_lifecycle_probe'];
      const generation = authority.host.snapshot().servers[0]?.generation;
      if (!(tool && generation)) {
        throw new Error('The actual MCP executor was not discovered');
      }
      const mcpId = `${configuredServerId}.host_lifecycle_probe`;
      const bindings = createAgentHostToolBindings({
        bindings: {
          [mcpId]: {
            identity: JSON.stringify([configuredServerId, generation, mcpId]),
            risk: 'mcp',
          },
        },
        resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
        tools: { [mcpId]: tool },
      });
      const mcpName = [...bindings.toolNameMap.keys()][0];
      const mcpTool = mcpName ? bindings.tools[mcpName] : undefined;
      if (!(mcpName && mcpTool)) {
        throw new Error('The actual MCP executor has no host binding');
      }
      // Hosted discovery defers the MCP tool: the model loads it before calling it.
      const model = scriptedToolSequence([
        { input: { text: 'ordinary native SQLite retrieval evidence' }, toolId: 'write_file' },
        { input: { toolName: mcpName }, toolId: 'load_tool' },
        { input: {}, toolId: mcpName },
        { input: { query: 'retrieval' }, toolId: 'search_index' },
      ]);
      host = await startAgentHost({ lifetime: 'persistent', root: profile }, async (startup) => {
        // The desktop reads assistant availability from the attached host, so
        // this host answers it as every production host does: its provider
        // services over a disposable credential file and the fixture key.
        const capabilities = await createHostCapabilities({
          env: { OPENAI_API_KEY: 'owned-fixture-key' },
          launch: { credentialStore: { kind: 'file', path: join(profile, 'credentials.json') } },
          startup,
        });
        return await createProductionHostPlatform({
          close: async () => {
            // The index writer must physically join before this host releases its root.
            await indexer.close();
            await runtimeClient?.disconnect();
            const report = await authority.host.close();
            expect(report.failures).toEqual([]);
          },
          mcp: {
            authority: authority.host,
            callAppTool: () => Promise.reject(new Error('This proof mounts no MCP App')),
            close: () => authority.host.close(),
            executableTools: async () => ({
              bindings: { [mcpName]: { configuredServerId, generation, tool: mcpTool } },
              close: async () => undefined,
              unavailable: [],
            }),
          },
          providers: capabilities.providers,
          readConfiguration: async (request) => {
            expect(request.modelId).toBe('openai::gpt-5.4');
            return {
              configuration: { model: 'gpt-5.4', provider: 'openai' },
              durableConfiguration: { model: 'gpt-5.4', provider: 'openai' },
              maxSteps: 5,
              memory: {
                native: {
                  options: {
                    observationalMemory: false,
                    semanticRecall: false,
                    workingMemory: { enabled: true, scope: 'thread' },
                  },
                },
                recordPrompt: async () => undefined,
                resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
              },
              providerRequestContext: { inputTokenLimit: 30_000, provider: 'openai' },
              resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
              tools: {
                search_index: {
                  description: 'Search the actual SQLite keyword index',
                  execute: (input) =>
                    indexer.search({
                      limit: 10,
                      mode: 'bm25',
                      rootIds: ['owned-root'],
                      text: z.object({ query: z.string() }).parse(input).query,
                    }),
                  identity: 'owned-native-index-reader',
                  inputSchema: z.object({ query: z.string() }),
                  risk: 'read',
                },
                write_file: {
                  description: 'Write and index the owned file',
                  execute: async (input) => {
                    const { text } = z.object({ text: z.string() }).parse(input);
                    await writeFile(path, text);
                    const plan = await indexer.prepareFile({
                      chunkLines: 1,
                      content: await readFile(path, 'utf8'),
                      fileId: 'owned-file',
                      relativePath: 'permitted.txt',
                      rootId: 'owned-root',
                    });
                    await indexer.commitTextFile({ plan });
                    return { path };
                  },
                  identity: 'owned-native-file-action',
                  inputSchema: z.object({ text: z.string() }),
                  risk: 'edit',
                },
              },
              toolTimeoutMs: resolveAssistantResilienceConfig().toolTimeoutMs,
            };
          },
          readPermissionPolicy: () => ({
            perToolOverrides: { [mcpId]: 'ask' },
            policies: { ...DEFAULT_PERMISSION_POLICIES },
            yolo: false,
          }),
          resolveModel: async () => model,
          resolveProviderAuth: async () => undefined,
          startup,
        });
      });
      client = await attachAgentHost(host.record);
      checkpoint('plain-node-production-host-ready');
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) {
          env[key] = value;
        }
      }
      Object.assign(env, {
        BRAINSTRIKE_DB_PROFILE: 'm3-owned',
        BRAINSTRIKE_DB_ROOT_PATH: disposable,
        BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
        BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES: '1',
        BRAINSTRIKE_E2E_USER_DATA_DIR: disposable,
        ELECTRON_IS_E2E_TEST: 'true',
        OPENAI_API_KEY: 'owned-fixture-key',
      });
      const launchOptions = {
        args: [
          join(desktop, 'dist/main.js'),
          '--test-mode',
          `--user-data-dir=${disposable}`,
          '--brainstrike-desktop-launch-mode=test-built',
        ],
        env,
        executablePath: process.env['BRAINSTRIKE_TEST_ELECTRON_EXEC_PATH'] ?? electronPath(),
      };
      application = await _electron.launch(launchOptions);
      const pid = application.process().pid;
      await observeApplication(application);
      const page = await application.firstWindow();
      page.on('pageerror', (cause) =>
        process.stderr.write(`ordinary renderer: ${cause.message}\n`)
      );
      checkpoint('ordinary-main-window');
      await page.waitForLoadState();
      await ensureAssistantShellVisible(page);
      // Preferences are owned by browser local storage, not Electron store.
      // This disposable fixture chooses a model; admission rejects substitution.
      await page.evaluate(
        (value) => localStorage.setItem('assistant-preferences.v1', value),
        JSON.stringify({
          state: { modelsByProvider: { openai: 'gpt-5.4' }, selectedModel: 'openai::gpt-5.4' },
          version: ASSISTANT_PREFERENCES_STORE_VERSION,
        })
      );
      await page.reload();
      await ensureAssistantShellVisible(page);
      const newThread = page.getByTestId('assistant-new-thread-button');
      await page.getByRole('textbox', { name: 'Message input' }).waitFor();
      const existing = new Set(
        (await client.request('thread/list', {})).threads.map(({ threadId }) => threadId)
      );
      await newThread.click();
      await expect
        .poll(
          async () =>
            (await client?.request('thread/list', {}))?.threads.filter(
              ({ threadId }) => !existing.has(threadId)
            ).length
        )
        .toBe(1);
      const threads = (await client.request('thread/list', {})).threads.filter(
        ({ threadId }) => !existing.has(threadId)
      );
      const threadId = threads[0]?.threadId;
      if (threads.length !== 1 || !threadId) {
        throw new Error('Ordinary New Thread did not create exactly one committed host thread');
      }
      const panel = page.getByTestId(`assistant-thread-panel-${threadId}`);
      const input = panel.getByRole('textbox', { name: 'Message input' });
      await input.waitFor();
      checkpoint('ordinary-new-thread-committed');
      await input.fill('Write the owned file, call MCP, and search its SQLite index.');
      await input.press('Enter');
      // Admission (MCP discovery, memory resolution) and the first model step
      // take seconds, not the poll's one-second default.
      await expect
        .poll(
          async () =>
            (await client?.request('thread/read', { fromSeq: 0, threadId }))?.rows.some(
              (row) => row.event.type === 'interaction.requested'
            ),
          { timeout: 30_000 }
        )
        .toBe(true);
      await expect(access(path)).rejects.toThrow();
      // A pending approval renders as its own card, outside any collapsed activity.
      await page.getByRole('button', { exact: true, name: 'Approve write_file' }).click();
      await expect
        .poll(
          async () =>
            (await client?.request('thread/read', { fromSeq: 0, threadId }))?.rows.filter(
              (row) => row.event.type === 'interaction.requested'
            ).length,
          { timeout: 30_000 }
        )
        .toBe(2);
      // The approval card names the tool by its catalog id, not the model-facing name.
      await page.getByRole('button', { exact: true, name: `Approve ${mcpId}` }).click();
      await page.getByText('Host run completed.', { exact: true }).waitFor();
      const result = await execute(process.execPath, [
        join(repository, 'packages/agent-host/dist/cli.js'),
        '--root',
        profile,
        'thread',
        'read',
        '--thread',
        threadId,
      ]);
      const rows = JSON.parse(result.stdout);
      await writeFile(join(evidence, 'committed-cli-read.json'), JSON.stringify(rows, null, 2));
      await page.screenshot({ path: join(evidence, 'ordinary-completed.png') });
      expect(await readFile(path, 'utf8')).toBe('ordinary native SQLite retrieval evidence');
      const committed = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      expect(committed.filter((row) => row.event.type === 'effect.finished')).toHaveLength(4);
      expect(committed.findLast((row) => row.event.type === 'run.finished')?.event).toMatchObject({
        outcome: 'completed',
        type: 'run.finished',
      });
      const workspace = await client.request('thread/workspace/read', { threadId });
      expect(workspace.snapshot).not.toBeNull();
      expect(committed.some((row) => row.event.type === 'workspace.updated')).toBe(true);
      await writeFile(
        join(evidence, 'committed-workspace.json'),
        JSON.stringify(workspace, null, 2)
      );
      const legacyOwners = await page.evaluate(
        async (id) =>
          window.electronAPI?.db.query('SELECT id FROM mastra_threads WHERE id = $1', [id]),
        threadId
      );
      expect(legacyOwners?.rows).toEqual([]);
      expect(
        server.requests.some(
          ({ body }) =>
            body && typeof body === 'object' && 'method' in body && body.method === 'tools/call'
        )
      ).toBe(true);
      checkpoint('ordinary-ui-and-cli-committed-view');
      await writeFile(
        join(evidence, 'ordinary-diagnostics.json'),
        JSON.stringify(await readDiagnostics(page), null, 2)
      );
      await page.reload();
      await page
        .getByTestId(`assistant-thread-panel-${threadId}`)
        .getByText('Host run completed.', { exact: true })
        .waitFor();
      expect(
        (await client.request('thread/read', { fromSeq: 0, threadId })).rows.slice(
          0,
          committed.length
        )
      ).toEqual(committed);
      expect(await client.request('thread/workspace/read', { threadId })).toEqual(workspace);
      checkpoint('ordinary-reload-same-committed-thread');
      await observeApplication(application);
      await application.close();
      application = undefined;
      if (pid) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      application = await _electron.launch(launchOptions);
      await observeApplication(application);
      const reopened = await application.firstWindow();
      await ensureAssistantShellVisible(reopened);
      await reopened
        .getByTestId(`assistant-thread-panel-${threadId}`)
        .getByText('Host run completed.', { exact: true })
        .waitFor();
      expect(
        (await client.request('thread/read', { fromSeq: 0, threadId })).rows.slice(
          0,
          committed.length
        )
      ).toEqual(committed);
      expect(await client.request('thread/workspace/read', { threadId })).toEqual(workspace);
      await writeFile(
        join(evidence, 'ordinary-reopened-diagnostics.json'),
        JSON.stringify(await readDiagnostics(reopened), null, 2)
      );
      await reopened.screenshot({ path: join(evidence, 'ordinary-reopened.png') });
      checkpoint('ordinary-app-reopen-same-committed-thread');
    } catch (cause) {
      originalFailure = cause;
      await writeFile(
        join(evidence, 'original-failure.json'),
        JSON.stringify(failureEvidence(cause), null, 2)
      );
      const captures: Promise<void>[] = [];
      const page = application?.windows()[0];
      if (page && !page.isClosed()) {
        captures.push(
          readDiagnostics(page).then((logs) =>
            writeFile(
              join(evidence, 'ordinary-failure-diagnostics.json'),
              JSON.stringify(logs, null, 2)
            )
          ),
          page.content().then((html) => writeFile(join(evidence, 'ordinary-failure.html'), html)),
          page.screenshot({ path: join(evidence, 'ordinary-failure.png') }).then(() => undefined),
          page
            .locator('body')
            .innerText()
            .then((content) => writeFile(join(evidence, 'ordinary-visible-text.txt'), content))
        );
      }
      if (client) {
        captures.push(
          client.request('thread/list', {}).then(async (threads) => {
            const rows = await Promise.all(
              threads.threads.map(({ threadId }) =>
                client?.request('thread/read', { fromSeq: 0, threadId })
              )
            );
            await writeFile(
              join(evidence, 'failure-committed-read.json'),
              JSON.stringify({ rows, threads }, null, 2)
            );
          })
        );
      }
      const results = await Promise.allSettled(captures);
      await writeFile(
        join(evidence, 'diagnostic-capture-failures.json'),
        JSON.stringify(
          results
            .filter((result) => result.status === 'rejected')
            .map((result) => failureEvidence(result.reason)),
          null,
          2
        )
      );
    } finally {
      await writeFile(join(evidence, 'ordinary-app.log'), appOutput.join(''));
      const closed = await Promise.allSettled([
        application?.close(),
        client?.close(),
        host?.close(),
      ]);
      closed.push(
        ...(await Promise.allSettled([
          indexer.close(),
          runtimeClient?.disconnect(),
          authority.host.close().then((report) => {
            expect(report.failures).toEqual([]);
          }),
        ]))
      );
      const failed = closed.filter((result) => result.status === 'rejected');
      await server.close();
      const owner = RootLock.inspect(profile)?.owner;
      const remainingAppPids = [...ownedAppPids].filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      await writeFile(
        join(evidence, 'cleanup.json'),
        JSON.stringify({
          failures: failed.map((result) => failureEvidence(result.reason)),
          remainingAppPids,
          rootReleased: owner?.released ?? true,
        })
      );
      checkpoint(`cleanup-evidence:${evidence}`);
      cleanupFailures.push(...failed.map((result) => result.reason));
      if (owner && !owner.released) {
        cleanupFailures.push(new Error('Ordinary qualification retained its root'));
      }
      if (remainingAppPids.length > 0) {
        cleanupFailures.push(new Error('Ordinary qualification retained owned Electron processes'));
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [...(originalFailure ? [originalFailure] : []), ...cleanupFailures],
        'Ordinary qualification and physical cleanup failed'
      );
    }
    if (originalFailure !== undefined) {
      throw originalFailure;
    }
  },
  getAdjustedTimeout('e2e')
);

function electronPath(): string {
  const value: unknown = createRequire(import.meta.url)('electron');
  if (typeof value !== 'string') {
    throw new TypeError('Electron package did not expose its executable path');
  }
  return value;
}
