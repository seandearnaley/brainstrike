/**
 * BST-2067: a real host process traces its runs as OpenTelemetry GenAI spans
 * through @ai-sdk/otel and exports them over OTLP/HTTP, only when the OTLP spec
 * endpoint variable is set. A local collector receives what the exporter sends;
 * prompts, responses and tool payloads stay out of the spans unless
 * `BRAINSTRIKE_OTEL_RECORD_CONTENT=1`, and a set but unusable configuration fails
 * host startup instead of starting untraced.
 */
import { type ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeHostRecord,
  decodeStartupMessage,
  HOST_VERSION,
  type StartupMessage,
} from '@brainstrike/host-lease';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { processStartTime } from '@brainstrike/state-store';
import { trace } from '@opentelemetry/api';
import { afterEach, expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost } from '../src/client.js';
import { HOST_TRACING_SERVICE_NAME, startHostTracing } from '../src/telemetry/otel.js';
import {
  OTEL_FIXTURE_MODEL_ID,
  OTEL_FIXTURE_TITLE,
  OTEL_FIXTURE_TOOL_INPUT,
  OTEL_FIXTURE_TOOL_RESULT,
} from './fixtures/otel-platform.mjs';

const entryPath = fileURLToPath(new URL('../dist/process-entry.js', import.meta.url));
const platformPath = fileURLToPath(new URL('./fixtures/otel-platform.mjs', import.meta.url));
const ANSWER = 'Host run completed.';
/** GenAI attributes that carry prompts, responses or tool payloads. */
const CONTENT_KEYS = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
];

const roots: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  await Promise.all(
    servers.splice(0).map((server) => new Promise((done) => server.close(() => done(undefined))))
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const Attribute = z.object({ key: z.string(), value: z.record(z.string(), z.unknown()) });
const ExportRequest = z.object({
  resourceSpans: z.array(
    z.object({
      resource: z.object({ attributes: z.array(Attribute) }),
      scopeSpans: z.array(
        z.object({
          spans: z.array(
            z.object({
              attributes: z.array(Attribute).default([]),
              name: z.string(),
              spanId: z.string(),
              traceId: z.string(),
            })
          ),
        })
      ),
    })
  ),
});

/** OTLP/JSON `AnyValue`: the scalar or array the exporter encoded. */
function anyValue(value: Record<string, unknown>): unknown {
  if ('stringValue' in value) {
    return value['stringValue'];
  }
  if ('intValue' in value) {
    return Number(value['intValue']);
  }
  if ('doubleValue' in value) {
    return value['doubleValue'];
  }
  if ('boolValue' in value) {
    return value['boolValue'];
  }
  if ('arrayValue' in value) {
    const { values } = z
      .object({ values: z.array(z.record(z.string(), z.unknown())).default([]) })
      .parse(value['arrayValue']);
    return values.map(anyValue);
  }
  throw new Error(`Unexpected OTLP value: ${JSON.stringify(value)}`);
}

function attributes(list: readonly z.infer<typeof Attribute>[]): Record<string, unknown> {
  return Object.fromEntries(list.map(({ key, value }) => [key, anyValue(value)]));
}

interface ExportedSpan {
  readonly attributes: Record<string, unknown>;
  readonly name: string;
  readonly resource: Record<string, unknown>;
  readonly traceId: string;
}

/** A local OTLP/HTTP collector: every export request and the spans it carried. */
async function startCollector() {
  const requests: string[] = [];
  const rejected: unknown[] = [];
  const spans: ExportedSpan[] = [];
  const server = createServer((request, response) => {
    const body: Buffer[] = [];
    request.on('data', (chunk: Buffer) => body.push(chunk));
    request.on('end', () => {
      requests.push(`${request.method} ${request.url} ${request.headers['content-type']}`);
      try {
        const exported = ExportRequest.parse(JSON.parse(Buffer.concat(body).toString('utf8')));
        for (const { resource, scopeSpans } of exported.resourceSpans) {
          for (const span of scopeSpans.flatMap((scope) => scope.spans)) {
            spans.push({
              attributes: attributes(span.attributes),
              name: span.name,
              resource: attributes(resource.attributes),
              traceId: span.traceId,
            });
          }
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      } catch (cause) {
        rejected.push(cause);
        response.writeHead(400).end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const address = server.address();
  if (!(address && typeof address === 'object')) {
    throw new Error('The collector has no port');
  }
  return { endpoint: `http://127.0.0.1:${address.port}`, rejected, requests, spans };
}

/** The real host entry, as the desktop utility and CLI launcher run it, with `env` added. */
function launchHost(root: string, env: NodeJS.ProcessEnv) {
  const start = processStartTime(process.pid);
  if (!start) {
    throw new Error('Cannot identify the launching test process');
  }
  const options = { lifetime: 'app', parent: { pid: process.pid, start }, root };
  const child = fork(entryPath, [JSON.stringify(options), platformPath], {
    env: { ...process.env, ...env },
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  const startup = new Promise<StartupMessage>((done, reject) => {
    child.once('message', (message: unknown) => done(decodeStartupMessage(message)));
    child.once('error', reject);
    void exited.then(() => reject(new Error(`Host exited before its startup report: ${stderr}`)));
  });
  return { child, exited, startup, stderr: () => stderr };
}

/** One run with one tool call on a fresh root; the host then closes as its launcher leaves. */
async function tracedRun(env: NodeJS.ProcessEnv, prompt: string) {
  const root = await mkdtemp(join(tmpdir(), 'bs-otel-tracing-'));
  roots.push(root);
  const host = launchHost(root, env);
  expect(await host.startup).toEqual({ event: 'ready' });
  const record = decodeHostRecord(JSON.parse(await readFile(join(root, 'host.json'), 'utf8')));
  const client = await attachAgentHost(record);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt,
    threadId,
  });
  await expect
    .poll(async () => {
      const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
      return rows.find(({ event }) => event.type === 'run.finished' && event.runId === runId)
        ?.event;
    })
    .toMatchObject({ outcome: 'completed' });
  await client.close();
  // An app-lifetime Node host closes when its launcher's channel ends (ADR-0017).
  host.child.disconnect();
  expect({ code: await host.exited, stderr: host.stderr() }).toMatchObject({ code: 0 });
  return { runId, threadId };
}

function genAi(spans: readonly ExportedSpan[], operation: string, agent?: string) {
  return spans.filter(
    (span) =>
      span.attributes['gen_ai.operation.name'] === operation &&
      (agent === undefined || span.attributes['gen_ai.agent.name'] === agent)
  );
}

test('a host run exports one GenAI trace over OTLP, with ids and usage but no content', async () => {
  const collector = await startCollector();
  const prompt = `Trace the private prompt ${randomUUID()}`;
  const { runId, threadId } = await tracedRun(
    { OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint },
    prompt
  );

  expect(collector.rejected).toEqual([]);
  expect(new Set(collector.requests)).toEqual(new Set(['POST /v1/traces application/json']));
  const { spans } = collector;
  for (const span of spans) {
    expect(span.resource).toMatchObject({
      'service.name': HOST_TRACING_SERVICE_NAME,
      'service.version': HOST_VERSION,
    });
  }
  const runs = genAi(spans, 'invoke_agent', 'brainstrike.host-run');
  expect(runs).toHaveLength(1);
  const [run] = runs;
  if (!run) {
    throw new Error('No host-run span');
  }
  expect(run).toMatchObject({
    attributes: {
      'ai.settings.context.runId': runId,
      'ai.settings.context.threadId': threadId,
      'gen_ai.request.model': OTEL_FIXTURE_MODEL_ID,
      'gen_ai.usage.input_tokens': 2,
      'gen_ai.usage.output_tokens': 2,
    },
    name: `invoke_agent ${OTEL_FIXTURE_MODEL_ID}`,
  });
  const traced = spans.filter((span) => span.traceId === run.traceId);
  // The tool-call step and the answering step each make one model call.
  const chats = genAi(traced, 'chat');
  expect(chats).toHaveLength(2);
  for (const chat of chats) {
    expect(chat).toMatchObject({
      attributes: {
        'gen_ai.request.model': OTEL_FIXTURE_MODEL_ID,
        'gen_ai.usage.input_tokens': 1,
        'gen_ai.usage.output_tokens': 1,
      },
      name: `chat ${OTEL_FIXTURE_MODEL_ID}`,
    });
  }
  expect(genAi(traced, 'execute_tool')).toEqual([
    expect.objectContaining({
      attributes: expect.objectContaining({ 'gen_ai.tool.name': 'read_note' }),
      name: 'execute_tool read_note',
    }),
  ]);
  // The title request is its own traced call, named and identified the same way.
  expect(genAi(spans, 'invoke_agent', 'brainstrike.thread-title')).toEqual([
    expect.objectContaining({
      attributes: expect.objectContaining({
        'ai.settings.context.runId': runId,
        'ai.settings.context.threadId': threadId,
      }),
    }),
  ]);

  const keys = spans.flatMap((span) => Object.keys(span.attributes));
  expect(keys.filter((key) => CONTENT_KEYS.includes(key))).toEqual([]);
  const recorded = JSON.stringify(spans.map((span) => span.attributes));
  for (const content of [
    prompt,
    ANSWER,
    OTEL_FIXTURE_TITLE,
    OTEL_FIXTURE_TOOL_INPUT,
    OTEL_FIXTURE_TOOL_RESULT,
  ]) {
    expect(recorded).not.toContain(content);
  }
});

test('BRAINSTRIKE_OTEL_RECORD_CONTENT=1 records prompts, responses and tool payloads', async () => {
  const collector = await startCollector();
  const prompt = `Trace the recorded prompt ${randomUUID()}`;
  await tracedRun(
    { BRAINSTRIKE_OTEL_RECORD_CONTENT: '1', OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint },
    prompt
  );

  expect(collector.rejected).toEqual([]);
  const [run] = genAi(collector.spans, 'invoke_agent', 'brainstrike.host-run');
  expect(run?.attributes['gen_ai.input.messages']).toEqual(expect.stringContaining(prompt));
  expect(run?.attributes['gen_ai.output.messages']).toEqual(expect.stringContaining(ANSWER));
  const traced = collector.spans.filter((span) => span.traceId === run?.traceId);
  expect(genAi(traced, 'execute_tool')).toEqual([
    expect.objectContaining({
      attributes: expect.objectContaining({
        'gen_ai.tool.call.arguments': expect.stringContaining(OTEL_FIXTURE_TOOL_INPUT),
        'gen_ai.tool.call.result': expect.stringContaining(OTEL_FIXTURE_TOOL_RESULT),
      }),
    }),
  ]);
  const [title] = genAi(collector.spans, 'invoke_agent', 'brainstrike.thread-title');
  expect(title?.attributes['gen_ai.output.messages']).toEqual(
    expect.stringContaining(OTEL_FIXTURE_TITLE)
  );
});

test('a configured but unusable OTLP endpoint fails host startup before the platform loads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-otel-tracing-'));
  roots.push(root);
  const host = launchHost(root, { OTEL_EXPORTER_OTLP_ENDPOINT: 'localhost:4318' });
  expect(await host.startup).toEqual({
    event: 'failed',
    kind: 'error',
    message: 'Host tracing could not start: OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL',
    ownership: 'released',
  });
  host.child.disconnect();
  expect(await host.exited).toBe(1);
  expect(host.stderr()).toContain('Host tracing could not start');
  await expect(readFile(join(root, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('tracing stays off and registers nothing unless an OTLP endpoint variable is set', async () => {
  for (const env of [
    {},
    { OTEL_EXPORTER_OTLP_ENDPOINT: '' },
    { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '  ' },
    { BRAINSTRIKE_OTEL_RECORD_CONTENT: '1', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
  ]) {
    await expect(startHostTracing(env)).resolves.toBeUndefined();
  }
  expect(globalThis.AI_SDK_TELEMETRY_INTEGRATIONS ?? []).toEqual([]);
  expect(trace.getTracer('probe').startSpan('probe').isRecording()).toBe(false);
});

test.each([
  [
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'localhost:4318' },
    'OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL',
  ],
  [
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://collector-user:collector-secret@127.0.0.1:4318' },
    'OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL',
  ],
  [
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://[collector/v1/traces',
    },
    'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an http(s) URL',
  ],
  [
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
    'OTEL_EXPORTER_OTLP_PROTOCOL=grpc is unsupported; the host exports http/json',
  ],
  [
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/protobuf',
    },
    'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf is unsupported; the host exports http/json',
  ],
  [
    {
      BRAINSTRIKE_OTEL_RECORD_CONTENT: 'yes',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    },
    'BRAINSTRIKE_OTEL_RECORD_CONTENT must be 1 or 0',
  ],
])('%o logs one error and rejects without registering', async (env, reason) => {
  const logged: LogRecord[] = [];
  onTestFinished(
    addLogListener((record) => {
      if (record.scope === 'AgentHostTracing') {
        logged.push(record);
      }
    })
  );
  await expect(startHostTracing(env)).rejects.toThrow(`Host tracing could not start: ${reason}`);
  expect(logged).toEqual([
    expect.objectContaining({
      args: ['Host tracing could not start', { code: 'host_tracing_invalid', reason }],
    }),
  ]);
  expect(JSON.stringify(logged)).not.toContain('collector-secret');
  expect(globalThis.AI_SDK_TELEMETRY_INTEGRATIONS ?? []).toEqual([]);
  expect(trace.getTracer('probe').startSpan('probe').isRecording()).toBe(false);
});
