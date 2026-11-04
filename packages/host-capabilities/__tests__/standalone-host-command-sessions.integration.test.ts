/**
 * Through the trusted model seam, the standalone host starts a command
 * session in its launch root, lists it, and ends it when the host stops.
 */
import { HOST_RESULT_SCHEMAS } from '@brainstrike/agent-host/protocol';
import { processStartTime } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  drainCleanup,
  recordedToolResults,
  standaloneHost,
  trustedPlatformModule,
} from './fixtures/standalone-trusted-host.ts';

afterEach(drainCleanup);

test('the standalone host starts a command session in its launch root and lists it', {
  timeout: 120_000,
}, async () => {
  // Both session tools are deferred; starting a session is execute-risk, so the run asks.
  const module = await trustedPlatformModule('trusted-fixture', [
    { input: { toolName: 'brainstrike_manageCommandSession' }, toolId: 'load_tool' },
    {
      input: { operation: { action: 'start', command: 'sleep 60' } },
      toolId: 'brainstrike_manageCommandSession',
    },
    { input: { toolName: 'brainstrike_inspectCommandSessions' }, toolId: 'load_tool' },
    {
      input: { operation: { action: 'list' } },
      toolId: 'brainstrike_inspectCommandSessions',
    },
  ]);
  const host = await standaloneHost({}, module);
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const asked = await host.command([
    'run',
    'Start a session.',
    '--model',
    'trusted-fixture::probe',
    '--json',
    '--non-interactive',
  ]);
  expect(asked.code, asked.stderr).toBe(2);
  const { runId, threadId } = z
    .object({ runId: z.string(), threadId: z.string() })
    .parse(JSON.parse(asked.stdout.split('\n')[0] || 'null'));
  const readRows = async () =>
    Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/read'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(JSON.parse((await host.command(['threads', 'show', '--thread', threadId])).stdout)).rows;
  const requested = (await readRows())
    .map((row) => row.event)
    .find((event) => event.type === 'interaction.requested');
  if (requested?.type !== 'interaction.requested') {
    throw new Error('The session start asked for no approval');
  }
  const approved = await host.command([
    'interaction',
    'respond',
    '--thread',
    threadId,
    '--run',
    runId,
    '--interaction',
    requested.interactionId,
    '--decision',
    'approve',
  ]);
  expect(approved, approved.stderr).toMatchObject({ code: 0 });
  await expect
    .poll(async () => (await readRows()).some((row) => row.event.type === 'run.finished'), {
      timeout: 30_000,
    })
    .toBe(true);
  const rows = await readRows();
  expect(rows.map((row) => row.event).find((event) => event.type === 'run.finished')).toMatchObject(
    { outcome: 'completed' }
  );
  // The model sees one running session in the launch root, started in a real pty by this host.
  const listed = recordedToolResults(rows).find(
    ({ toolCallId }) => toolCallId === 'recorded-call-4'
  );
  const text = z
    .object({ type: z.literal('text'), value: z.string() })
    .parse(listed?.output, { reportInput: true }).value;
  const { sessions } = z
    .object({
      sessions: z.array(z.object({ cwd: z.string(), pid: z.number(), status: z.string() })),
    })
    .parse(JSON.parse(text));
  expect(sessions).toEqual([{ cwd: host.workspace, pid: expect.any(Number), status: 'running' }]);
  const [session] = sessions;
  expect(processStartTime(session?.pid ?? 0)).not.toBeNull();
  // Stopping the host ends the session's process with it.
  expect(await host.command(['host', 'stop'])).toMatchObject({ code: 0 });
  await expect.poll(() => processStartTime(session?.pid ?? 0), { timeout: 30_000 }).toBeNull();
});
