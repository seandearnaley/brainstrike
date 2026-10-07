// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startStatefulMcpHostServer } from '@brainstrike/agent/test-fixtures/mcp-host-lifecycle';
import { AGENT_HOST_PROTOCOL_VERSION, attachAgentHost } from '@brainstrike/agent-host';
import { ASSISTANT_PREFERENCES_STORE_VERSION } from '@brainstrike/app-state/stores/assistant-preferences-store-version';
import {
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  encodeFileMentionId,
  parseOpenRouterModelMetadata,
  serializeFileMentionDirective,
} from '@brainstrike/assistant-contract';
import { decodeHostRecord, type HostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock, RootLockedError } from '@brainstrike/state-store';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { _electron, type ElectronApplication } from 'playwright';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { ensureAssistantShellVisible } from '../../e2e/utils/layout-helpers';
import {
  type ModelProviderRequest,
  type ModelProviderScript,
  startModelProviderShim,
} from '../../e2e/utils/model-provider-shim';

const desktop = resolve(import.meta.dirname, '../..');
// Public Models API response recorded without credentials or inference.
const recordedModelMetadata = parseOpenRouterModelMetadata(
  JSON.parse(
    await readFile(
      new URL('./fixtures/openrouter-sonnet-4-6-model-metadata.json', import.meta.url),
      'utf8'
    )
  ),
  'anthropic/claude-sonnet-4.6',
  Date.parse('2026-10-07T05:07:09.516Z')
);
async function routeRecordedModelMetadata(application: ElectronApplication): Promise<void> {
  // Only metadata HTTP is intercepted; tools/IPC/SQLite/view stay real.
  await application.context().route('**/assistant/openrouter-model?*', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ freshness: 'live', metadata: recordedModelMetadata }),
      contentType: 'application/json',
    });
  });
}
test.for(['normal', 'normal-om', 'utility-loss'] as const)(
  'ordinary desktop owns the first M3 Root, New Thread, CLI attachment and reopen (%s)',
  { timeout: getAdjustedTimeout('e2e') },
  async (fault, context) => {
    // This native-tail fixture uses POSIX SIGTERM handling; Windows needs its
    // own physical tail fixture rather than treating taskkill as a grace period.
    if (fault === 'utility-loss' && process.platform === 'win32') {
      context.skip();
    }
    const disposable = await mkdtemp(join(tmpdir(), 'brainstrike-m3-app-owned-'));
    const profile = join(disposable, 'profiles/m3-owned');
    await mkdir(profile, { recursive: true });
    const evidence = `${disposable}-evidence`;
    await mkdir(evidence, { recursive: true });
    const workspace = join(disposable, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'AGENTS.md'), 'M3 workspace context sentinel 7246.');
    await writeFile(join(workspace, 'referenced.txt'), 'M3 referenced file sentinel 9312.');
    await writeFile(
      join(workspace, 'owned-command.mjs'),
      `import { writeFileSync } from 'node:fs';
${fault === 'utility-loss' ? "process.on('SIGTERM', () => {});" : ''}
writeFileSync('owned-command-pid.json', JSON.stringify({ pid: process.pid, ppid: process.ppid, electron: process.versions.electron ?? null }));
process.stdout.write('owned command started\\n');
setInterval(() => {}, 1000);
`
    );
    await mkdir(join(workspace, '.brainstrike/skills/m3-owned-skill'), { recursive: true });
    await writeFile(
      join(workspace, '.brainstrike/skills/m3-owned-skill/SKILL.md'),
      '---\nname: m3-owned-skill\ndescription: A disposable M3 qualification skill.\n---\nM3 activated skill sentinel 8521.'
    );
    const fixture = await startStatefulMcpHostServer();
    const providerRequests: ModelProviderRequest[] = [];
    const observerRequests: ModelProviderRequest[] = [];
    const withObserver =
      (
        select: (request: ModelProviderRequest) => ModelProviderScript
      ): ((request: ModelProviderRequest) => ModelProviderScript) =>
      (request) => {
        if (
          // The recorded provider request resolves the saved catalog alias
          // to this dated model ID before dispatch.
          z.object({ model: z.literal('qwen/qwen3.8-max-0902') }).safeParse(request.requestBody)
            .success
        ) {
          observerRequests.push(request);
          return {
            finalText:
              '<observations>\n- The user requested an owned workspace operation.\n</observations>',
          };
        }
        return select(request);
      };
    let workspaceRootId: string | undefined;
    const model = await startModelProviderShim(
      withObserver((request) => {
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
      })
    );
    await mkdir(join(disposable, 'mcp'));
    // This shared recorded-runtime fixture speaks the SDK's legacy protocol;
    // the configured selection must match it, as in the host lifecycle lanes.
    await writeFile(
      join(disposable, 'mcp/mcp.config.json'),
      JSON.stringify({
        servers: [
          {
            name: 'owned-mcp',
            protocol: 'legacy',
            transport: 'streamable-http',
            url: fixture.url,
          },
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
    const captured = new WeakSet<NonNullable<typeof application>>();
    const capture = async (app: NonNullable<typeof application>): Promise<void> => {
      if (!captured.has(app)) {
        const process = app.process();
        const start = process.pid && processStartTime(process.pid);
        if (process.pid && start) {
          owners.push({ pid: process.pid, start });
        }
        process.stdout?.on('data', (data: Buffer) => outputs.push(data.toString()));
        process.stderr?.on('data', (data: Buffer) => outputs.push(data.toString()));
        captured.add(app);
      }
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
      await routeRecordedModelMetadata(application);
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
            ['anthropic/claude-sonnet-4.6', 'openrouter']
          );
          localStorage.setItem(
            'assistant-preferences.v1',
            JSON.stringify({
              state: {
                modelsByProvider: { openrouter: 'anthropic/claude-sonnet-4.6' },
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
                selectedModel: 'openrouter::anthropic/claude-sonnet-4.6',
              },
              version,
            })
          );
          await window.electronAPI.storage.setItem(
            'assistant-memory-preferences.v1',
            JSON.stringify({
              state: {
                ...memory,
                observationalMemory: { ...memory.observationalMemory },
              },
              version: 2,
            })
          );
        },
        {
          memory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
            observationalMemory: {
              ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
              enabled: fault === 'normal-om',
              messageTokens: 30,
              modelTarget: 'openrouter/qwen/qwen3.8-max',
              observationTokens: 50_000,
              retrievalMode: 'off',
              scope: 'thread',
            },
          },
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
      expect(record.protocolVersion).toBe(AGENT_HOST_PROTOCOL_VERSION);
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
      const mountedRootId = workspaceRootId;
      if (!mountedRootId) {
        throw new Error('The ordinary workspace has no mounted root');
      }
      await page.evaluate((threadId) => {
        const previous = JSON.parse(
          localStorage.getItem('brainstrike-assistant-threads-v1') ?? '{"state":{},"version":4}'
        ) as { state: Record<string, unknown>; version: number };
        localStorage.setItem(
          'brainstrike-assistant-threads-v1',
          JSON.stringify({
            ...previous,
            state: {
              ...previous.state,
              draftRuntimeByThreadId: {
                [threadId]: {
                  model: 'anthropic/claude-sonnet-4.6',
                  modelSettings: { maxOutputTokens: 733, temperature: 0.35 },
                  provider: 'openrouter',
                },
              },
            },
          })
        );
      }, threadId);
      await page.reload();
      await ensureAssistantShellVisible(page);
      const panel = page.getByTestId(`assistant-thread-panel-${threadId}`);
      const input = panel.getByRole('textbox', { name: 'Message input' });
      if (fault === 'normal') {
        await input.fill('Keep this draft while correcting the output limit.');
        await panel.getByRole('button', { name: 'Open assistant controls' }).click();
        await page.getByText('Output & Limits', { exact: true }).click();
        const output = page.getByRole('spinbutton', { name: 'Output token limit' });
        await output.fill('999999999');
        await output.press('Enter');
        await expect
          .poll(() => panel.getByRole('button', { exact: true, name: 'Send' }).isDisabled())
          .toBe(true);
        expect(providerRequests).toHaveLength(0);
        await output.press('Escape');
        await expect
          .poll(() => panel.getByRole('button', { exact: true, name: 'Send' }).isEnabled())
          .toBe(true);
        expect(await input.inputValue()).toBe('Keep this draft while correcting the output limit.');
        expect(providerRequests).toHaveLength(0);
        await input.press('Escape');
        checkpoint('ordinary-settings-draft-validation');
      }
      await input.fill('');
      await input.pressSequentially('/skill:m3-owned-skill');
      await page
        .getByTestId('assistant-slash-popover')
        .getByRole('option', { name: 'm3-owned-skill' })
        .click();
      const activatedDraft = await input.inputValue();
      expect(activatedDraft).toContain(':skill[m3-owned-skill]');
      expect(providerRequests).toHaveLength(0);
      await panel
        .getByRole('textbox', { name: 'Message input' })
        .fill(
          `Write the owned file, call MCP, and inspect workspace context. ${activatedDraft} ${serializeFileMentionDirective({ id: encodeFileMentionId(mountedRootId, 'referenced.txt'), label: 'referenced.txt' })}`
        );
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
      let committed = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
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
      const requestBody = z
        .object({ max_tokens: z.number(), temperature: z.number() })
        .parse(providerRequests[0]?.requestBody);
      expect(requestBody.max_tokens).toBe(733);
      expect(requestBody.temperature).toBe(0.35);
      expect(started.snapshot?.configuration['intent']).toMatchObject({
        modelConfiguration: { modelSettings: { maxOutputTokens: 733, temperature: 0.35 } },
      });
      const system = providerRequests[0]?.messages.filter(
        (message) => z.object({ role: z.literal('system') }).safeParse(message).success
      );
      expect(JSON.stringify(system)).toContain('M3 workspace context sentinel 7246.');
      expect(JSON.stringify(system)).toContain('M3 referenced file sentinel 9312.');
      expect(JSON.stringify(system)).toContain('M3 activated skill sentinel 8521.');
      expect(providerRequests[0]?.toolNames).toContain('skill');
      expect(started.snapshot?.configuration['system']).toBeTypeOf('string');
      if (fault === 'normal-om') {
        expect(observerRequests.length).toBeGreaterThan(0);
        expect(
          committed.some(
            ({ event }) => event.type === 'memory.usage' && event.kind === 'observation'
          )
        ).toBe(true);
      }
      await expect
        .poll(async () => panel.getByTestId('context-usage-trigger').getAttribute('aria-label'))
        .toBe('Context usage: 0% of input budget');
      expect(await panel.getByTestId('context-usage-trigger').getAttribute('title')).toContain(
        'context 7 /'
      );
      checkpoint('ordinary-default-native-mcp-context-run-completed');
      model.setScript(
        withObserver((request) => {
          providerRequests.push(request);
          return {
            finalText: 'The denied file was not written.',
            toolCall: {
              arguments: {
                content: 'must not be written',
                path: 'denied.txt',
                root: mountedRootId,
              },
              name: 'brainstrike_writeWorkspaceFile',
            },
          };
        })
      );
      await input.fill('Deny this owned file write.');
      await input.press('Enter');
      await expect
        .poll(
          async () =>
            (await client?.request('thread/read', { fromSeq: 0, threadId }))?.rows.filter(
              ({ event }) => event.type === 'interaction.requested'
            ).length
        )
        .toBe(2);
      await page.getByRole('button', { exact: true, name: 'Expand activity' }).last().click();
      await page
        .getByRole('button', { exact: true, name: 'Decline brainstrike_writeWorkspaceFile' })
        .click();
      await expect
        .poll(
          async () =>
            (await client?.request('thread/read', { fromSeq: 0, threadId }))?.rows.filter(
              ({ event }) => event.type === 'run.finished'
            ).length
        )
        .toBe(2);
      await expect(stat(join(workspace, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      checkpoint('ordinary-denied-effect-refused');

      model.setScript(
        withObserver((request) => {
          providerRequests.push(request);
          return {
            finalText: 'The owned command completed.',
            toolCall: {
              arguments: { command: 'node owned-command.mjs', root: mountedRootId },
              name: 'brainstrike_executeCommand',
            },
          };
        })
      );
      await input.fill('Start the owned command, then stop it.');
      await input.press('Enter');
      await expect
        .poll(
          async () =>
            (await client?.request('thread/read', { fromSeq: 0, threadId }))?.rows.filter(
              ({ event }) => event.type === 'interaction.requested'
            ).length
        )
        .toBe(3);
      await page.getByRole('button', { exact: true, name: 'Expand activity' }).last().click();
      await page
        .getByRole('button', { exact: true, name: 'Approve brainstrike_executeCommand' })
        .click();
      let commandOwner: { pid: number; ppid: number; electron: null } | undefined;
      await expect
        .poll(async () => {
          try {
            commandOwner = z
              .object({
                electron: z.null(),
                pid: z.number().int().positive(),
                ppid: z.number().int().positive(),
              })
              .parse(JSON.parse(await readFile(join(workspace, 'owned-command-pid.json'), 'utf8')));
            return true;
          } catch (cause) {
            if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
              return false;
            }
            throw cause;
          }
        })
        .toBe(true);
      if (!commandOwner) {
        throw new Error('The actual native command did not record its process identity');
      }
      const commandPids = [commandOwner.pid, commandOwner.ppid].filter(
        (pid) => pid !== application?.process().pid
      );
      const commandIdentities = commandPids.map((pid) => {
        const start = processStartTime(pid);
        if (!start) {
          throw new Error('The owned command exited before the cancellation check');
        }
        return { pid, start };
      });
      owners.push(...commandIdentities);
      if (fault === 'utility-loss') {
        const originalOwner = RootLock.inspect(profile)?.owner;
        expect(processStartTime(record.pid)).toBe(record.start);
        // Explicit fault injection targets only this test's proven-owned utility.
        // The real native executor still owns its existing SIGTERM/grace tail.
        process.kill(record.pid, 'SIGKILL');
        await expect.poll(() => processStartTime(record.pid)).not.toBe(record.start);
        const before = commandIdentities.filter(
          ({ pid, start }) => processStartTime(pid) === start
        );
        expect(before.length).toBeGreaterThan(0);
        let contender: RootLock | undefined;
        let refusal: unknown;
        try {
          contender = await RootLock.acquire(profile);
        } catch (cause) {
          refusal = cause;
        }
        const after = commandIdentities.filter(({ pid, start }) => processStartTime(pid) === start);
        await writeFile(
          join(evidence, 'utility-loss-root-reuse.json'),
          JSON.stringify(
            {
              after,
              before,
              contender: contender?.owner,
              originalOwner,
              refusal: refusal instanceof Error ? refusal.message : null,
              utility: { pid: record.pid, start: record.start },
            },
            null,
            2
          )
        );
        contender?.release();
        expect(after.length).toBeGreaterThan(0);
        expect(refusal).toBeInstanceOf(RootLockedError);
        return;
      }
      const activeRows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      const commandRun = activeRows.findLast(({ event }) => event.type === 'run.started')?.event;
      if (commandRun?.type !== 'run.started') {
        throw new Error('The native command has no committed run');
      }
      await client.close();
      await client.closed;
      client = undefined;
      const ordinaryUrl = page.url();
      await page.goto('about:blank');
      expect(processStartTime(record.pid)).toBe(record.start);
      client = await attachAgentHost(record);
      expect(
        (await client.request('thread/read', { fromSeq: 0, threadId })).rows.slice(
          0,
          activeRows.length
        )
      ).toEqual(activeRows);
      await client.request('run/stop', {
        commandId: crypto.randomUUID(),
        runId: commandRun.runId,
        threadId,
      });
      for (const { pid, start } of commandIdentities) {
        expect(processStartTime(pid)).not.toBe(start);
      }
      const stopped = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      expect(
        stopped.some(
          ({ event }) =>
            event.type === 'run.finished' &&
            event.runId === commandRun.runId &&
            event.outcome === 'stopped'
        )
      ).toBe(true);
      await writeFile(
        join(evidence, 'native-command-cleanup.json'),
        JSON.stringify(
          {
            commandIdentities,
            commandRun: commandRun.runId,
            host: { pid: record.pid, start: record.start },
            stoppedRows: stopped,
          },
          null,
          2
        )
      );
      await page.goto(ordinaryUrl);
      await ensureAssistantShellVisible(page);
      await page.getByTestId(`assistant-thread-panel-${threadId}`).waitFor();
      committed = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      checkpoint('ordinary-client-loss-reconnect-stop-physical-command-joined');
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
      await routeRecordedModelMetadata(application);
      await capture(application);
      const reopened = await application.firstWindow();
      await ensureAssistantShellVisible(reopened);
      await reopened.getByTestId(`assistant-thread-panel-${threadId}`).waitFor();
      let next: HostRecord | undefined;
      await expect
        .poll(async () => {
          try {
            next = decodeHostRecord(JSON.parse(await readFile(join(profile, 'host.json'), 'utf8')));
            return next.protocolVersion === AGENT_HOST_PROTOCOL_VERSION;
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
      await expect
        .poll(async () =>
          reopened
            .getByTestId(`assistant-thread-panel-${threadId}`)
            .getByTestId('context-usage-trigger')
            .getAttribute('aria-label')
        )
        .toBe('Context usage: 0% of input budget');
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
        }
      } catch (cause) {
        errors.push(cause);
      }
      try {
        await application?.close();
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
  }
);
