import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_RESULT_SCHEMAS, HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import { removeFixtureRoot } from '@brainstrike/agent-host/test-fixtures/cooperative-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import plan from '@brainstrike/test-utils/fixtures/committed-host-plan.json' with { type: 'json' };
import question from '@brainstrike/test-utils/fixtures/committed-host-question.json' with {
  type: 'json',
};
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';

/** The canonical human tools plus the shared workspace tools a standalone host runs. */
const STANDALONE_NATIVE_TOOL_IDS = [
  NATIVE_TOOL_ID.askUser,
  NATIVE_TOOL_ID.submitPlan,
  NATIVE_TOOL_ID.readWorkspaceFile,
  NATIVE_TOOL_ID.readWorkspaceDirectory,
  NATIVE_TOOL_ID.writeWorkspaceFile,
  NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
  NATIVE_TOOL_ID.deleteWorkspaceFile,
  NATIVE_TOOL_ID.renameWorkspaceFile,
  NATIVE_TOOL_ID.manageTaskList,
  NATIVE_TOOL_ID.manageCanvas,
  NATIVE_TOOL_ID.globWorkspace,
  NATIVE_TOOL_ID.findWorkspaceSymbol,
];

const bin = fileURLToPath(new URL('../bin/brainstrike.mjs', import.meta.url));
const httpFixture = new URL('./fixtures/standalone-production-http.mjs', import.meta.url).href;
const roots: string[] = [];

interface OfflineInteraction {
  readonly kind: 'question' | 'plan';
  readonly receipt: string;
}

function command(dataRoot: string, args: readonly string[], http: OfflineInteraction) {
  return new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
    execFile(
      process.execPath,
      [bin, '--data-root', dataRoot, ...args],
      {
        cwd: tmpdir(),
        env: {
          BRAINSTRIKE_M3_STANDALONE_HTTP: http.kind,
          BRAINSTRIKE_M3_STANDALONE_RECEIPT: http.receipt,
          BRAINSTRIKE_OPENAI_API_KEY: 'offline-standalone-fixture',
          LC_ALL: 'C',
          NODE_OPTIONS: `--import=${httpFixture}`,
          PATH: process.env['PATH'],
          SystemRoot: process.env['SystemRoot'],
          TZ: 'UTC',
        },
        timeout: 10_000,
        windowsHide: true,
      },
      (cause, stdout, stderr) => {
        if (!cause) {
          resolve({ code: 0, stderr, stdout });
        } else if (typeof cause.code === 'number') {
          resolve({ code: cause.code, stderr, stdout });
        } else {
          reject(cause);
        }
      }
    );
  });
}

async function owner(dataRoot: string) {
  return decodeHostRecord(JSON.parse(await readFile(join(dataRoot, 'host.json'), 'utf8')));
}

async function receipts(http: OfflineInteraction) {
  return (await readFile(http.receipt, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)));
}

async function stop(dataRoot: string, http: OfflineInteraction) {
  const selected = await owner(dataRoot);
  expect(await command(dataRoot, ['host', 'stop'], http)).toMatchObject({ code: 0 });
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  await expect.poll(() => processStartTime(selected.pid)).toBeNull();
}

afterEach(async () => {
  for (const dataRoot of roots.splice(0)) {
    const selected = RootLock.inspect(dataRoot)?.owner;
    if (selected && !selected.released) {
      await stop(dataRoot, { kind: 'question', receipt: join(dataRoot, 'offline-receipt.jsonl') });
    }
    await removeFixtureRoot(dataRoot);
  }
});

async function readRows(dataRoot: string, threadId: string, http: OfflineInteraction) {
  const result = await command(dataRoot, ['threads', 'show', '--thread', threadId], http);
  expect(result).toMatchObject({ code: 0, stderr: '' });
  return HOST_RESULT_SCHEMAS['thread/read'].parse(JSON.parse(result.stdout)).rows;
}

test.each(
  [
    { kind: 'question' as const, output: { answer: 'Local' }, resumeData: { answer: 'Local' } },
    {
      kind: 'question' as const,
      output: { answer: 'Local, Preview' },
      resumeData: { answer: ['Local', 'Preview'] },
    },
    { kind: 'plan' as const, output: { status: 'approved' }, resumeData: { action: 'approved' } },
    {
      kind: 'plan' as const,
      output: { feedback: 'Inspect the current change first.', status: 'rejected' },
      resumeData: { action: 'rejected', feedback: 'Inspect the current change first.' },
    },
  ].flatMap((fixture) => [false, true].map((restart) => ({ ...fixture, restart })))
)(
  'real production bin resumes $kind once (restart=$restart, response=$resumeData)',
  async (fixture) => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'bs-m3-standalone-interactions-'));
    roots.push(dataRoot);
    const http: OfflineInteraction = {
      kind: fixture.kind,
      receipt: join(dataRoot, 'offline-receipt.jsonl'),
    };
    const execute = (args: readonly string[]) => command(dataRoot, args, http);
    expect(await execute(['host', 'start'])).toMatchObject({ code: 0, stderr: '' });
    const firstOwner = await owner(dataRoot);
    const recordedRows = HostLogRowSchema.array().parse(
      fixture.kind === 'question' ? question : plan
    );
    const recorded = recordedRows.find(
      ({ event }) => event.type === 'interaction.requested'
    )?.event;
    if (recorded?.type !== 'interaction.requested') {
      throw new Error('The existing recorded canonical interaction has no request');
    }
    const paused = await execute([
      'run',
      'Use the recorded canonical human interaction.',
      '--model',
      'openai::gpt-6-sol',
      '--json',
      '--non-interactive',
    ]);
    expect(paused.code, paused.stderr).toBe(2);
    const receipt = z
      .object({ runId: z.string(), threadId: z.string() })
      .parse(JSON.parse(paused.stdout.split('\n')[0] ?? ''));
    const { runId, threadId } = receipt;
    const pausedRows = await readRows(dataRoot, threadId, http);
    const requested = pausedRows.find(({ event }) => event.type === 'interaction.requested')?.event;
    expect(requested).toMatchObject({
      input: recorded.input,
      kind: fixture.kind,
      toolId: recorded.toolId,
    });
    if (requested?.type !== 'interaction.requested') {
      throw new Error('The real production CLI did not expose the canonical human interaction');
    }
    expect(pausedRows.some(({ event }) => event.type === 'effect.started')).toBe(false);
    expect(pausedRows.filter(({ event }) => event.type === 'interaction.requested')).toHaveLength(
      1
    );
    expect(pausedRows.find(({ event }) => event.type === 'run.started')?.event).toMatchObject({
      snapshot: {
        configuration: {
          capabilities: {
            configuredMcp: 'unavailable',
            nativeTools: {
              available: STANDALONE_NATIVE_TOOL_IDS,
              remaining: 'unavailable',
            },
            vectorMemory: 'unavailable',
          },
          intent: { enabledNativeToolIds: STANDALONE_NATIVE_TOOL_IDS },
        },
        toolIdentities: {
          brainstrike_askUser: NATIVE_TOOL_ID.askUser,
          brainstrike_submitPlan: NATIVE_TOOL_ID.submitPlan,
        },
      },
    });
    expect(
      (await receipts(http)).filter((item) => item['phase'] === 'provider-request')
    ).toHaveLength(1);
    if (fixture.restart) {
      await stop(dataRoot, http);
      expect(await execute(['host', 'start'])).toMatchObject({ code: 0, stderr: '' });
      expect((await owner(dataRoot)).start).not.toBe(firstOwner.start);
      expect(await readRows(dataRoot, threadId, http)).toEqual(pausedRows);
      expect(
        (await receipts(http)).filter((item) => item['phase'] === 'provider-request')
      ).toHaveLength(1);
    }
    const attached = await execute([
      'attach',
      '--thread',
      threadId,
      '--run',
      runId,
      '--json',
      '--non-interactive',
    ]);
    expect(attached.code).toBe(2);
    expect(attached.stdout).toContain(requested.interactionId);
    const args = [
      'interaction',
      'resume',
      '--thread',
      threadId,
      '--run',
      runId,
      '--interaction',
      requested.interactionId,
      '--resume-data',
    ];
    expect(await execute([...args, '{"unexpected":true}'])).toMatchObject({ code: 1, stdout: '' });
    expect(
      await execute([
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
      ])
    ).toMatchObject({ code: 1, stdout: '' });
    expect(
      (await readRows(dataRoot, threadId, http)).some(
        ({ event }) => event.type === 'effect.started'
      )
    ).toBe(false);
    const response = [...args, JSON.stringify(fixture.resumeData), '--command-id', randomUUID()];
    const accepted = await execute(response);
    expect(accepted).toEqual({ code: 0, stderr: '', stdout: '{"accepted":true}\n' });
    expect(await execute(response)).toEqual(accepted);
    const finished = await execute([
      'attach',
      '--thread',
      threadId,
      '--run',
      runId,
      '--json',
      '--non-interactive',
    ]);
    expect(finished).toMatchObject({ code: 0, stderr: '' });
    expect(finished.stdout).toContain('Offline standalone production reply');
    const rows = await readRows(dataRoot, threadId, http);
    expect(rows.filter(({ event }) => event.type === 'interaction.responded')).toHaveLength(1);
    expect(rows.find(({ event }) => event.type === 'interaction.responded')?.event).toMatchObject({
      resumeData: fixture.resumeData,
    });
    expect(rows.filter(({ event }) => event.type === 'effect.started')).toHaveLength(1);
    expect(rows.filter(({ event }) => event.type === 'effect.finished')).toHaveLength(1);
    expect(rows.find(({ event }) => event.type === 'effect.finished')?.event).toMatchObject({
      output: fixture.output,
    });
    const prepared = rows.filter(({ event }) => event.type === 'provider.request.prepared');
    const steps = rows.filter(({ event }) => event.type === 'model.step');
    expect(prepared).toHaveLength(2);
    expect(steps).toHaveLength(2);
    for (const [index, row] of prepared.entries()) {
      expect(row.seq).toBeLessThan(steps[index]?.seq ?? 0);
      expect(row.event).toMatchObject({ modelId: 'gpt-6-sol', provider: 'openai', runId });
      if (row.event.type !== 'provider.request.prepared') {
        throw new Error('Prepared request has no canonical accounting');
      }
      const accounting = z
        .object({ promptTokens: z.number(), toolTokens: z.number(), totalTokens: z.number() })
        .parse(row.event.accounting);
      expect(accounting.toolTokens).toBeGreaterThan(0);
      expect(accounting.totalTokens).toBe(accounting.promptTokens + accounting.toolTokens);
      expect(accounting.totalTokens).toBeLessThan(869_500);
    }
    expect(JSON.stringify(rows)).not.toContain('offline-standalone-fixture');
    const requests = (await receipts(http)).filter((item) => item['phase'] === 'provider-request');
    expect(requests).toHaveLength(2);
    const followup = z
      .object({ input: z.array(z.record(z.string(), z.json())) })
      .parse(requests[1]?.['body']);
    const output = followup.input.find((item) => item['type'] === 'function_call_output');
    expect(output?.['call_id']).toBe('call_standalone_human_1');
    expect(JSON.parse(z.string().parse(output?.['output']))).toEqual(fixture.output);
    await stop(dataRoot, http);
    const joined = await receipts(http);
    expect(joined.some((item) => item['phase'] === 'forbidden-capability')).toBe(false);
    for (const item of joined.filter((entry) => entry['phase'] === 'process-start')) {
      expect(item['electron']).toBeNull();
      expect(item['executable']).toBe(process.execPath);
    }
    expect(joined).toContainEqual(
      expect.objectContaining({ code: 0, phase: 'process-exit', pid: firstOwner.pid })
    );
  }
);
