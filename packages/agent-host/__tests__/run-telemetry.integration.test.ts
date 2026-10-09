/**
 * A running tool's live telemetry (shell-output slices, MCP progress) reaches a
 * thread's subscribers as `run/telemetry` and is never committed: committing it
 * throttled live tools on disk commits and bloated every reload (ADR-0011
 * amendment). Every other tool-writer chunk still commits as `stream.chunk`.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PERMISSION_POLICIES,
  MCP_PROGRESS_STREAM_PART_TYPE,
  SHELL_OUTPUT_STREAM_PART_TYPE,
} from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostRunTelemetry } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const KEPT = { note: 'committed as before', type: 'brainstrike.example.chunk' };

test('a command’s live output reaches subscribers without committing a stream.chunk row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-run-telemetry-'));
  roots.push(root);
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, read: 'allow' },
        yolo: false,
      }),
      resolveModel: async () => scriptedModel('run_command'),
      tools: {
        run_command: {
          description: 'Run a command',
          execute: async (_input, context) => {
            await context.write?.({
              chunk: 'STREAM_STDOUT_FIRST',
              stream: 'stdout',
              toolCallId: context.toolCallId,
              type: SHELL_OUTPUT_STREAM_PART_TYPE,
            });
            await context.write?.({
              progress: 1,
              toolCallId: context.toolCallId,
              total: 2,
              type: MCP_PROGRESS_STREAM_PART_TYPE,
            });
            await context.write?.(KEPT);
            return { exitCode: 0, stdout: 'STREAM_STDOUT_FIRST' };
          },
          identity: 'native-run-command-generation-1',
          inputSchema: z.object({ text: z.string() }),
          risk: 'read',
        },
      },
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const telemetry: HostRunTelemetry[] = [];
  client.onTelemetry((received) => telemetry.push(received));
  await client.request('log/subscribe', { fromSeq: 0, threadId });

  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Run the command',
    threadId,
  });
  const finished = async () =>
    (await client.request('thread/read', { fromSeq: 0, threadId })).rows.some(
      ({ event }) => event.type === 'run.finished'
    );
  await expect.poll(finished).toBe(true);

  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
  const started = rows.find(({ event }) => event.type === 'run.started')?.event;
  const effect = rows.find(({ event }) => event.type === 'effect.started')?.event;
  const chunks = rows.flatMap(({ event }) => (event.type === 'stream.chunk' ? [event.chunk] : []));
  const telemetryTypes = new Set([SHELL_OUTPUT_STREAM_PART_TYPE, MCP_PROGRESS_STREAM_PART_TYPE]);
  expect(
    chunks.filter(
      (chunk) =>
        typeof chunk === 'object' &&
        chunk !== null &&
        telemetryTypes.has(String((chunk as { type?: unknown }).type))
    )
  ).toEqual([]);
  expect(chunks).toContainEqual(KEPT);
  expect(started?.type).toBe('run.started');
  const runId = started?.type === 'run.started' ? started.runId : undefined;
  const toolCallId = effect?.type === 'effect.started' ? effect.toolCallId : undefined;
  expect(toolCallId).toBeTypeOf('string');
  expect(telemetry).toEqual([
    {
      chunk: {
        chunk: 'STREAM_STDOUT_FIRST',
        stream: 'stdout',
        toolCallId,
        type: SHELL_OUTPUT_STREAM_PART_TYPE,
      },
      runId,
      threadId,
      toolCallId,
    },
    {
      chunk: { progress: 1, toolCallId, total: 2, type: MCP_PROGRESS_STREAM_PART_TYPE },
      runId,
      threadId,
      toolCallId,
    },
  ]);
});
