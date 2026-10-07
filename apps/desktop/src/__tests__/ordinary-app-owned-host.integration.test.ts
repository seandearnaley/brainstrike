// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startStatefulMcpHostServer } from '@brainstrike/agent/test-fixtures/mcp-host-lifecycle';
import { attachAgentHost } from '@brainstrike/agent-host';
import { ASSISTANT_PREFERENCES_STORE_VERSION } from '@brainstrike/app-state/stores/assistant-preferences-store-version';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract';
import { decodeHostRecord, type HostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { _electron } from 'playwright';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { ensureAssistantShellVisible } from '../../e2e/utils/layout-helpers';
import {
  type ModelProviderRequest,
  startModelProviderShim,
} from '../../e2e/utils/model-provider-shim';

const desktop = resolve(import.meta.dirname, '../..');
test(
  'ordinary desktop owns the first M3 Root, New Thread, CLI attachment and reopen',
  async () => {
    const disposable = await mkdtemp(join(tmpdir(), 'brainstrike-m3-app-owned-'));
    const profile = join(disposable, 'profiles/m3-owned');
    await mkdir(profile, { recursive: true });
    const evidence = `${disposable}-evidence`;
    await mkdir(evidence, { recursive: true });
    const workspace = join(disposable, 'workspace');
    await mkdir(workspace);
    const fixture = await startStatefulMcpHostServer();
    const providerRequests: ModelProviderRequest[] = [];
    let workspaceRootId: string | undefined;
    const model = await startModelProviderShim((request) => {
      providerRequests.push(request);
      const mcp = request.toolNames.find((name) => name.endsWith('_host_lifecycle_probe'));
      if (!mcp) {
        throw new Error('The default catalog did not include the configured MCP executor');
      }
      if (!workspaceRootId) {
        throw new Error('The ordinary workspace has no authoritative root identity');
      }
      return {
        finalText: 'Owned native and MCP effects completed.',
        toolCallStages: [
          [
            {
              arguments: {
                content: 'ordinary app-owned M3 evidence',
                path: 'permitted.txt',
                root: workspaceRootId,
              },
              name: 'brainstrike_writeWorkspaceFile',
            },
          ],
          [{ arguments: {}, name: mcp }],
          [{ arguments: {}, name: 'brainstrike_listWorkspaceContext' }],
        ],
      };
    });
    await mkdir(join(disposable, 'mcp'));
    // This shared recorded-runtime fixture speaks the SDK's legacy protocol;
    // the configured selection must match it, as in the host lifecycle lanes.
    await writeFile(
      join(disposable, 'mcp/mcp.config.json'),
      JSON.stringify({
        servers: [
          { name: 'owned-mcp', protocol: 'legacy', transport: 'streamable-http', url: fixture.url },
        ],
      })
    );
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        name !== 'ELECTRON_RUN_AS_NODE' &&
        !/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|AWS_)/.test(name)
      ) {
        env[name] = value;
      }
    }
    Object.assign(env, {
      BRAINSTRIKE_DB_PROFILE: 'm3-owned',
      BRAINSTRIKE_DB_ROOT_PATH: disposable,
      BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
      BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES: '1',
      BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
      BRAINSTRIKE_E2E_USER_DATA_DIR: disposable,
      BRAINSTRIKE_OPENROUTER_API_KEY: 'owned-local-fixture-key',
      ELECTRON_IS_E2E_TEST: 'true',
      OPENROUTER_BASE_URL: model.baseUrl,
    });
    const options = {
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
    };
    let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    let client: Awaited<ReturnType<typeof attachAgentHost>> | undefined;
    let failure: unknown;
    const errors: unknown[] = [];
    const outputs: string[] = [];
    const owners: { pid: number; start: string }[] = [];
    const capture = async (app: NonNullable<typeof application>): Promise<void> => {
      app.process().stdout?.on('data', (data: Buffer) => outputs.push(data.toString()));
      app.process().stderr?.on('data', (data: Buffer) => outputs.push(data.toString()));
      for (const { pid } of await app.evaluate(({ app }) => app.getAppMetrics())) {
        const start = processStartTime(pid);
        if (start) {
          owners.push({ pid, start });
        }
      }
    };
    const checkpoint = (phase: string): void => {
      process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), phase })}\n`);
    };
    try {
      expect(RootLock.inspect(profile)).toBeNull();
      checkpoint('ordinary-launch-start');
      application = await _electron.launch(options);
      checkpoint('ordinary-main-launched');
      await capture(application);
      const page = await application.firstWindow();
      await ensureAssistantShellVisible(page);
      await page.getByRole('textbox', { name: 'Message input' }).waitFor();
      await page.evaluate(
        async ({ memory, version }) => {
          if (!(window.electronAPI?.db && 'storage' in window.electronAPI)) {
            throw new Error('The normal desktop DB/storage bridge is missing');
          }
          await window.electronAPI.db.query(
            'UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2',
            ['openai/gpt-5.4', 'openrouter']
          );
          localStorage.setItem(
            'assistant-preferences.v1',
            JSON.stringify({
              state: {
                modelsByProvider: { openrouter: 'openai/gpt-5.4' },
                providerSettings: {
                  openrouter: {
                    agentInputTokenLimit: 24_000,
                    agentMaxSteps: 8,
                    maxOutputTokens: 900,
                    memoryLastMessages: 7,
                    temperature: 0.2,
                    workingMemoryEnabled: true,
                  },
                },
                selectedModel: 'openrouter::openai/gpt-5.4',
              },
              version,
            })
          );
          await window.electronAPI.storage.setItem(
            'assistant-memory-preferences.v1',
            JSON.stringify({
              state: {
                ...memory,
                observationalMemory: { ...memory.observationalMemory, enabled: false },
              },
              version: 2,
            })
          );
        },
        {
          memory: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          version: ASSISTANT_PREFERENCES_STORE_VERSION,
        }
      );
      await page.reload();
      await ensureAssistantShellVisible(page);
      // Use the ordinary grant/mount flow. A detached SQL row is deliberately
      // disconnected by workspace reconciliation and cannot authorize tools.
      await page.getByRole('button', { exact: true, name: 'Add Folder to Workspace' }).click();
      await expect
        .poll(async () => {
          const roots = await page.evaluate(
            async (workspace) =>
              await window.electronAPI?.db.query(
                'SELECT id FROM roots WHERE path = $1 AND status = $2',
                [workspace, 'live']
              ),
            workspace
          );
          const parsed = z.object({ rows: z.array(z.object({ id: z.string() })) }).parse(roots);
          workspaceRootId = parsed.rows[0]?.id;
          return workspaceRootId !== undefined;
        })
        .toBe(true);
      checkpoint('ordinary-assistant-visible');
      await page.getByTestId('assistant-new-thread-button').click();
      checkpoint('ordinary-new-thread-clicked');
      const record = decodeHostRecord(
        JSON.parse(await readFile(join(profile, 'host.json'), 'utf8'))
      );
      expect(record.protocolVersion).toBe(5);
      expect(record.pid).not.toBe(process.pid);
      const start = processStartTime(record.pid);
      if (start) {
        owners.push({ pid: record.pid, start });
      }
      client = await attachAgentHost(record);
      let discoveredThreadId: string | undefined;
      await expect
        .poll(async () => {
          const catalog = await client?.request('thread/list', {});
          const candidate = catalog?.threads.at(-1)?.threadId;
          if (
            candidate &&
            (await page.getByTestId(`assistant-thread-panel-${candidate}`).isVisible())
          ) {
            discoveredThreadId = candidate;
            return true;
          }
          return false;
        })
        .toBe(true);
      const threadId = discoveredThreadId;
      if (!threadId) {
        throw new Error('New Thread has no committed Root identity');
      }
      checkpoint('ordinary-new-thread-rendered');
      const panel = page.getByTestId(`assistant-thread-panel-${threadId}`);
      await panel
        .getByRole('textbox', { name: 'Message input' })
        .fill('Write the owned file, call MCP, and inspect workspace context.');
      await panel.getByRole('textbox', { name: 'Message input' }).press('Enter');
      await expect
        .poll(async () =>
          (await client?.request('thread/read', { fromSeq: 0, threadId }))?.rows.some(
            ({ event }) => event.type === 'interaction.requested'
          )
        )
        .toBe(true);
      await expect(readFile(join(workspace, 'permitted.txt'), 'utf8')).rejects.toThrow();
      await page.getByRole('button', { exact: true, name: 'Expand activity' }).first().click();
      await page
        .getByRole('button', { exact: true, name: 'Approve brainstrike_writeWorkspaceFile' })
        .click();
      await expect
        .poll(async () =>
          (await client?.request('thread/read', { fromSeq: 0, threadId }))?.rows.some(
            ({ event }) => event.type === 'run.finished' && event.outcome === 'completed'
          )
        )
        .toBe(true);
      expect(await readFile(join(workspace, 'permitted.txt'), 'utf8')).toBe(
        'ordinary app-owned M3 evidence'
      );
      const committed = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      expect(committed.some(({ event }) => event.type === 'thread.started')).toBe(true);
      expect(committed.filter(({ event }) => event.type === 'effect.finished')).toHaveLength(3);
      const started = committed.find(({ event }) => event.type === 'run.started')?.event;
      if (started?.type !== 'run.started') {
        throw new Error('Default tool run has no committed start');
      }
      expect(started.snapshot?.maxSteps).toBe(8);
      expect(JSON.stringify(committed)).not.toContain('owned-local-fixture-key');
      expect(
        fixture.requests.some(
          ({ body }) =>
            z.object({ method: z.string() }).safeParse(body).data?.method === 'tools/call'
        )
      ).toBe(true);
      expect(providerRequests.length).toBeGreaterThan(3);
      // Provider preferences currently project the output window through the
      // shared builder; temperature belongs to a thread's explicit draft.
      expect(
        z.object({ max_tokens: z.number() }).parse(providerRequests[0]?.requestBody).max_tokens
      ).toBe(900);
      checkpoint('ordinary-default-native-mcp-context-run-completed');
      await client.close();
      await client.closed;
      client = undefined;
      await page.reload();
      await ensureAssistantShellVisible(page);
      await page.getByTestId(`assistant-thread-panel-${threadId}`).waitFor();
      checkpoint('ordinary-reload-same-thread');
      client = await attachAgentHost(record);
      const reloadedRows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      expect(reloadedRows.slice(0, committed.length)).toEqual(committed);
      // Mount restoration can append a new canonical workspace command. The
      // already committed conversation must stay byte-for-byte unchanged.
      expect(
        reloadedRows
          .slice(committed.length)
          .every(
            ({ event }) =>
              event.type === 'workspace.updated' ||
              (event.type === 'command.accepted' && event.method === 'thread/workspace/set')
          )
      ).toBe(true);
      await client.close();
      await client.closed;
      client = undefined;
      await capture(application);
      await application.close();
      application = undefined;
      expect(processStartTime(record.pid)).not.toBe(record.start);
      expect(RootLock.inspect(profile)?.owner.released).toBe(true);
      application = await _electron.launch(options);
      await capture(application);
      const reopened = await application.firstWindow();
      await ensureAssistantShellVisible(reopened);
      await reopened.getByTestId(`assistant-thread-panel-${threadId}`).waitFor();
      let next: HostRecord | undefined;
      await expect
        .poll(async () => {
          try {
            next = decodeHostRecord(JSON.parse(await readFile(join(profile, 'host.json'), 'utf8')));
            return next.protocolVersion === 5;
          } catch (cause) {
            if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
              return false;
            }
            throw cause;
          }
        })
        .toBe(true);
      if (!next) {
        throw new Error('Reopened desktop has no ready Root record');
      }
      checkpoint('ordinary-reopened-root-ready');
      client = await attachAgentHost(next);
      expect(
        (await client.request('thread/read', { fromSeq: 0, threadId })).rows.slice(
          0,
          reloadedRows.length
        )
      ).toEqual(reloadedRows);
      await writeFile(
        join(evidence, 'verdict.json'),
        JSON.stringify(
          {
            first: record.pid,
            mcpRequests: fixture.requests,
            providerRequests,
            reopened: next.pid,
            rows: committed,
            threadId,
          },
          null,
          2
        )
      );
    } catch (cause) {
      failure = cause;
      const page = application?.windows()[0];
      if (page && !page.isClosed()) {
        const captures = await Promise.allSettled([
          page.screenshot({ path: join(evidence, 'failure.png') }),
          page.content().then((value) => writeFile(join(evidence, 'failure.html'), value)),
          page
            .evaluate(async () => ({
              main: await window.logging.getBufferedLogs(),
              renderer: (
                window as Window & {
                  __brainstrikeRendererLogBuffer?: { getRecords(): readonly unknown[] };
                }
              ).__brainstrikeRendererLogBuffer?.getRecords(),
              stores: { threads: localStorage.getItem('assistant-threads.v1') },
            }))
            .then((value) =>
              writeFile(join(evidence, 'failure-diagnostics.json'), JSON.stringify(value, null, 2))
            ),
        ]);
        await writeFile(
          join(evidence, 'capture-failures.json'),
          JSON.stringify(captures.filter((value) => value.status === 'rejected').map(String))
        );
      }
      await writeFile(
        join(evidence, 'first-failure.json'),
        JSON.stringify(
          { message: String(cause), stack: cause instanceof Error ? cause.stack : undefined },
          null,
          2
        )
      );
    } finally {
      try {
        await client?.close();
        await client?.closed;
      } catch (cause) {
        errors.push(cause);
      }
      try {
        if (application) {
          await capture(application);
          await application.close();
        }
      } catch (cause) {
        errors.push(cause);
      }
      try {
        await fixture.close();
      } catch (cause) {
        errors.push(cause);
      }
      try {
        await model.close();
      } catch (cause) {
        errors.push(cause);
      }
      const remaining = owners.filter(({ pid, start }) => processStartTime(pid) === start);
      await writeFile(join(evidence, 'output.log'), outputs.join(''));
      await writeFile(
        join(evidence, 'cleanup.json'),
        JSON.stringify(
          {
            errors: errors.map(String),
            failure: failure ? String(failure) : null,
            remaining,
            rootReleased: RootLock.inspect(profile)?.owner.released,
          },
          null,
          2
        )
      );
      process.stderr.write(`App-owned M3 evidence: ${evidence}\n`);
      if (remaining.length > 0) {
        errors.push(new Error('Owned app or Root process remains live'));
      }
      if (!failure && errors.length === 0) {
        await rm(disposable, { recursive: true });
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        [...(failure ? [failure] : []), ...errors],
        'Ordinary app-owned qualification and cleanup failed'
      );
    }
    if (failure) {
      throw failure;
    }
  },
  getAdjustedTimeout('e2e')
);
