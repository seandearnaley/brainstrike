// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent';
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
import { openIndexer } from '@brainstrike/indexer';
import { RootLock } from '@brainstrike/state-store';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { _electron } from 'playwright';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { ensureAssistantShellVisible } from '../../e2e/utils/layout-helpers';
import { createAgentHostToolBindings } from '../agent-host-tool-bindings';
import { McpHostRuntime } from '../mcp/node-host-runtime';

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, '../../../..');
const desktop = join(repository, 'apps/desktop');

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
    const disposable = await mkdtemp(join(tmpdir(), 'brainstrike-m3-ordinary-'));
    const profile = join(disposable, 'profiles', 'm3-owned');
    await mkdir(profile, { recursive: true });
    const evidence = join('/tmp', `brainstrike-m3-ordinary-evidence-${randomUUID()}`);
    await mkdir(evidence, { recursive: true });
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
      openTaskDatabase: unavailable,
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
      const mcpId = `${configuredServerId}_host_lifecycle_probe`;
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
      const model = scriptedToolSequence([
        { input: { text: 'ordinary native SQLite retrieval evidence' }, toolId: 'write_file' },
        { input: {}, toolId: mcpName },
        { input: { query: 'retrieval' }, toolId: 'search_index' },
      ]);
      host = await startAgentHost({ lifetime: 'persistent', root: profile }, (startup) =>
        createProductionHostPlatform({
          close: async () => {
            await runtimeClient?.disconnect();
            const report = await authority.host.close();
            expect(report.failures).toEqual([]);
          },
          mcp: {
            authority: authority.host,
            close: () => authority.host.close(),
            executableTools: async () => ({
              [mcpName]: { configuredServerId, generation, tool: mcpTool },
            }),
          },
          readConfiguration: async () => ({
            configuration: { model: 'gpt-5.4', provider: 'openai' },
            durableConfiguration: { model: 'gpt-5.4', provider: 'openai' },
            maxSteps: 4,
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
          }),
          readPermissionPolicy: () => ({
            perToolOverrides: { [mcpName]: 'ask' },
            policies: { ...DEFAULT_PERMISSION_POLICIES },
            yolo: false,
          }),
          resolveModel: async () => model,
          resolveProviderAuth: async () => undefined,
          startup,
        })
      );
      client = await attachAgentHost(host.record);
      checkpoint('plain-node-production-host-ready');
      // Seed only disposable preference data before the normal app owns this file.
      await writeFile(
        join(disposable, 'electron-storage.json'),
        JSON.stringify({
          'assistant-preferences.v1': JSON.stringify({
            state: { selectedModel: 'openai::gpt-5.4' },
            version: ASSISTANT_PREFERENCES_STORE_VERSION,
          }),
        })
      );
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
      application = await _electron.launch({
        args: [
          join(desktop, 'dist/main.js'),
          '--test-mode',
          `--user-data-dir=${disposable}`,
          '--brainstrike-desktop-launch-mode=test-built',
        ],
        env,
        executablePath:
          process.env['BRAINSTRIKE_TEST_ELECTRON_EXEC_PATH'] ??
          join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      });
      const pid = application.process().pid;
      application.process().stdout?.on('data', (data: Buffer) => appOutput.push(data.toString()));
      application.process().stderr?.on('data', (data: Buffer) => appOutput.push(data.toString()));
      const page = await application.firstWindow();
      page.on('pageerror', (cause) =>
        process.stderr.write(`ordinary renderer: ${cause.message}\n`)
      );
      checkpoint('ordinary-main-window');
      await ensureAssistantShellVisible(page);
      await page.getByTestId('assistant-new-thread-button').click();
      await expect
        .poll(async () => (await client?.request('thread/list', {}))?.threads.length)
        .toBe(1);
      const { threads } = await client.request('thread/list', {});
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
      await expect
        .poll(async () =>
          (await client?.request('thread/read', { fromSeq: 0, threadId }))?.rows.some(
            (row) => row.event.type === 'interaction.requested'
          )
        )
        .toBe(true);
      await expect(access(path)).rejects.toThrow();
      await page.getByRole('button', { exact: true, name: 'Expand activity' }).first().click();
      await page.getByRole('button', { exact: true, name: 'Approve write_file' }).click();
      await expect
        .poll(
          async () =>
            (await client?.request('thread/read', { fromSeq: 0, threadId }))?.rows.filter(
              (row) => row.event.type === 'interaction.requested'
            ).length
        )
        .toBe(2);
      await panel.getByRole('button', { exact: true, name: 'Expand activity' }).last().click();
      await page.getByRole('button', { exact: true, name: `Approve ${mcpName}` }).click();
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
      expect(committed.filter((row) => row.event.type === 'effect.finished')).toHaveLength(3);
      expect(committed.at(-1)?.event).toMatchObject({ outcome: 'completed', type: 'run.finished' });
      expect(
        server.requests.some(
          ({ body }) =>
            body && typeof body === 'object' && 'method' in body && body.method === 'tools/call'
        )
      ).toBe(true);
      checkpoint('ordinary-ui-and-cli-committed-view');
      await application.close();
      application = undefined;
      if (pid) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } catch (cause) {
      originalFailure = cause;
      const page = application?.windows()[0];
      if (page && !page.isClosed()) {
        await writeFile(join(evidence, 'ordinary-failure.html'), await page.content());
        await page.screenshot({ path: join(evidence, 'ordinary-failure.png') });
        await writeFile(
          join(evidence, 'ordinary-visible-text.txt'),
          await page.locator('body').innerText()
        );
      }
      if (client) {
        const threads = await client.request('thread/list', {});
        const rows = await Promise.all(
          threads.threads.map(({ threadId }) =>
            client?.request('thread/read', { fromSeq: 0, threadId })
          )
        );
        await writeFile(
          join(evidence, 'failure-committed-read.json'),
          JSON.stringify({ rows, threads }, null, 2)
        );
      }
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
      await writeFile(
        join(evidence, 'cleanup.json'),
        JSON.stringify({
          failures: failed.map((result) => failureEvidence(result.reason)),
          rootReleased: owner?.released ?? true,
        })
      );
      checkpoint(`cleanup-evidence:${evidence}`);
      if (failed.length > 0 || (owner && !owner.released)) {
        cleanupFailures.push(...failed.map((result) => result.reason));
        if (owner && !owner.released) {
          cleanupFailures.push(new Error('Ordinary qualification retained its root'));
        }
      } else {
        await rm(disposable, { force: true, recursive: true });
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
