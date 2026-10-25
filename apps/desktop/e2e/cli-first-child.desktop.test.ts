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
test('CLI-created children and their CLI follow-up appear in the GUI', async ({
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
  const launch = [
    '--workspace',
    workspace,
    '--credential-store',
    'file',
    '--credential-file',
    path.join(root, 'synthetic-empty-credentials.json'),
  ];
  try {
    // The CLI runs its host in its own process, before the app opens this profile.
    const [identity] = (
      await command([
        'run',
        'Delegate one Explorer child.',
        '--model',
        'openai::gpt-6-sol',
        '--json',
        '--non-interactive',
        ...launch,
      ])
    ).split('\n');
    const thread = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['run/start'], {
      errors: 'all',
      onExcessProperty: 'ignore',
    })(JSON.parse(identity ?? 'null'));
    const threadIdentity = Schema.decodeUnknownSync(Schema.Struct({ threadId: Schema.String }), {
      errors: 'all',
      onExcessProperty: 'ignore',
    })(JSON.parse(identity ?? 'null'));
    const children = async () =>
      Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/children'], {
        errors: 'all',
        onExcessProperty: 'error',
      })(JSON.parse(await command(['children', 'list', '--thread', threadIdentity.threadId])))
        .children;
    const [child, ...others] = await children();
    expect(others).toEqual([]);
    if (!(child && thread.runId)) {
      throw new Error('The CLI did not create its child');
    }
    expect(
      JSON.parse(await command(['thread', 'read', '--thread', child.threadId, '--from-seq', '0']))
    ).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ outcome: 'completed', type: 'run.finished' }),
        }),
      ]),
    });
    await command([
      'run',
      'CLI_CHILD_FOLLOWUP',
      '--thread',
      child.threadId,
      '--model',
      'openai::gpt-6-sol',
      '--json',
      '--non-interactive',
      ...launch,
    ]);
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
    await expect(
      childPanel.getByText('CLI CHILD FOLLOWUP RESPONSE', { exact: true })
    ).toBeVisible();
    await window.reload();
    await expect(
      window
        .getByRole('region', { exact: true, name: child.callSign })
        .getByText('CLI CHILD FOLLOWUP RESPONSE', { exact: true })
    ).toBeVisible();
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    await rm(workspace, { recursive: true });
  }
});
