import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HOST_RESULT_SCHEMAS } from '@brainstrike/agent-host/protocol';
import { Schema } from 'effect';
import { expect, test } from './fixtures/electron-fixture';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { resolveProviderEgressEnvironment } from './utils/model-provider-shim';

const require = createRequire(import.meta.url);
const executable = path.join(
  path.dirname(require.resolve('@brainstrike/host-capabilities')),
  '../bin/brainstrike.mjs'
);
const execute = promisify(execFile);
test.use({ electronEnv: { BRAINSTRIKE_OPENAI_API_KEY: 'offline-cli-first-fixture' } });
test('CLI-created children appear in the GUI and retain their identity through CLI follow-up', async ({
  electron,
  modelProvider,
}) => {
  const root = path.join(electron.getUserDataDir(), 'profiles', 'test');
  const workspace = await mkdtemp(path.join(tmpdir(), 'bs-m4-cli-child-'));
  const environment = {
    ...resolveProviderEgressEnvironment(modelProvider, []),
    BRAINSTRIKE_OPENAI_API_KEY: 'offline-cli-first-fixture',
    PATH: process.env['PATH'],
    TMPDIR: process.env['TMPDIR'],
  };
  const command = async (args: readonly string[]) =>
    (
      await execute(process.execPath, [executable, '--data-root', root, ...args], {
        env: environment,
        timeout: 20_000,
      })
    ).stdout;
  modelProvider.setScript(({ messages, requestBody, toolNames }) => {
    if (
      (
        requestBody as {
          stream?: unknown;
        }
      ).stream !== true
    ) {
      return { finalText: 'CLI child parent' };
    }
    const history = JSON.stringify(messages);
    if (history.includes('CLI_CHILD_TASK')) {
      return {
        finalText: history.includes('CLI_CHILD_FOLLOWUP')
          ? 'CLI CHILD FOLLOWUP RESPONSE'
          : 'CLI CHILD RESPONSE',
      };
    }
    if (!toolNames.includes('agent-explore')) {
      return { finalText: 'CLI delegation unavailable' };
    }
    if (
      history.includes('Background invocations of this turn') ||
      history.includes('<child_continuation_result>')
    ) {
      return { finalText: 'CLI parent received child' };
    }
    return {
      finalText: 'CLI parent started its child',
      toolCall: { arguments: { prompt: 'CLI_CHILD_TASK' }, name: 'agent-explore' },
    };
  });
  let started = false;
  try {
    const identity: unknown = JSON.parse(
      await command([
        'host',
        'start',
        '--workspace',
        workspace,
        '--credential-store',
        'file',
        '--credential-file',
        path.join(root, 'synthetic-empty-credentials.json'),
      ])
    );
    started = true;
    const thread = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/start'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(JSON.parse(await command(['thread', 'start'])));
    const run = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['run/start'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(
      JSON.parse(
        await command([
          'run',
          'start',
          '--thread',
          thread.threadId,
          '--model',
          'openai::gpt-6-sol',
          '--prompt',
          'Delegate one Explorer child.',
        ])
      )
    );
    await command([
      'attach',
      '--thread',
      thread.threadId,
      '--run',
      run.runId,
      '--json',
      '--non-interactive',
    ]);
    const children = async () =>
      Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/children'], {
        errors: 'all',
        onExcessProperty: 'error',
      })(JSON.parse(await command(['children', 'list', '--thread', thread.threadId]))).children;
    await expect.poll(async () => (await children()).length).toBe(1);
    const child = (await children())[0];
    if (!child) {
      throw new Error('The CLI did not create its child');
    }
    await expect
      .poll(async () =>
        JSON.parse(await command(['thread', 'read', '--thread', child.threadId, '--from-seq', '0']))
      )
      .toMatchObject({
        rows: expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({ outcome: 'completed', type: 'run.finished' }),
          }),
        ]),
      });
    const window = await electron.ensureWindow();
    await ensureAssistantShellVisible(window);
    const sidebar = window.getByTestId('show-threads-panel');
    if (await sidebar.isVisible()) {
      await sidebar.click();
    }
    await window.getByTestId('threads-tab-trigger').click();
    await window
      .getByTestId('threads-panel')
      .getByText('CLI child parent', { exact: true })
      .click();
    const region = window.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('button', { exact: true, name: 'Expand activity' }).first().click();
    await region
      .getByRole('button', { exact: true, name: `Open ${child.callSign} conversation` })
      .click();
    const childPanel = window.getByRole('region', { exact: true, name: child.callSign });
    await expect(childPanel.getByText('CLI CHILD RESPONSE', { exact: true })).toBeVisible();
    await command([
      'child',
      'send',
      '--thread',
      child.threadId,
      '--model',
      'openai::gpt-6-sol',
      '--prompt',
      'CLI_CHILD_FOLLOWUP',
    ]);
    await expect(
      childPanel.getByText('CLI CHILD FOLLOWUP RESPONSE', { exact: true })
    ).toBeVisible();
    await window.reload();
    await expect(
      window
        .getByRole('region', { exact: true, name: child.callSign })
        .getByText('CLI CHILD FOLLOWUP RESPONSE', { exact: true })
    ).toBeVisible();
    expect(JSON.parse(await command(['host', 'status']))).toEqual(identity);
    expect((await children()).map(({ threadId }) => threadId)).toEqual([child.threadId]);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    if (started) {
      await command(['host', 'stop']);
    }
    await rm(workspace, { recursive: true });
  }
});
