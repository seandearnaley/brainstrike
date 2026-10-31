/**
 * The standalone platform's trusted model seam. Absent, `--model` resolves
 * through the canonical catalog to the real provider SDK, and no flag can name
 * a trusted model. Present (only through a trusted `--platform` module), the
 * injected model runs under its own identity, which `run.started` and each
 * `model.step` name, and no catalog model runs beside it. Through it, a scripted
 * call shows the host's own workspace tools run over its launch root.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOST_RESULT_SCHEMAS } from '@brainstrike/agent-host/protocol';
import { removeFixtureRoot } from '@brainstrike/agent-host/test-fixtures/cooperative-host';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';

const bin = fileURLToPath(new URL('../bin/brainstrike.mjs', import.meta.url));
const platform = pathToFileURL(fileURLToPath(new URL('../src/platform.ts', import.meta.url))).href;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

/** A loopback OpenAI stand-in that refuses every request and keeps what it was sent. */
async function refusingProvider() {
  const requests: { body: Record<string, unknown>; url: string }[] = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => {
      text += String(chunk);
    });
    request.on('end', () => {
      requests.push({ body: JSON.parse(text || '{}'), url: request.url ?? '' });
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'trusted-model fixture refuses' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!(address && typeof address === 'object')) {
    throw new Error('No fixture port');
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function standaloneHost(
  env: Readonly<Record<string, string>>,
  platformModule?: string,
  files: Readonly<Record<string, string>> = {}
) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-m3-trusted-model-data-'));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'bs-trusted-model-ws-')));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(workspace, name), text);
  }
  const command = (args: readonly string[]) =>
    new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        [bin, '--data-root', dataRoot, ...args],
        {
          cwd: tmpdir(),
          env: { ...env, LC_ALL: 'C', PATH: process.env['PATH'], TZ: 'UTC' },
          timeout: 60_000,
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
  cleanup.push(async () => {
    const owner = RootLock.inspect(dataRoot)?.owner;
    if (owner && !owner.released) {
      const { pid } = decodeHostRecord(
        JSON.parse(await readFile(join(dataRoot, 'host.json'), 'utf8'))
      );
      expect(await command(['host', 'stop'])).toMatchObject({ code: 0 });
      await expect.poll(() => processStartTime(pid), { timeout: 30_000 }).toBeNull();
    }
    await rm(workspace, { force: true, recursive: true });
    await removeFixtureRoot(dataRoot);
  });
  const started = await command([
    'host',
    'start',
    '--workspace',
    workspace,
    ...(platformModule ? ['--platform', platformModule] : []),
  ]);
  const run = async (model: string) => {
    const result = await command([
      'run',
      'Say hello.',
      '--model',
      model,
      '--json',
      '--non-interactive',
    ]);
    const identity = z
      .object({ runId: z.string(), threadId: z.string() })
      .safeParse(JSON.parse(result.stdout.split('\n')[0] || 'null'));
    if (!identity.success) {
      return { result };
    }
    const shown = await command(['threads', 'show', '--thread', identity.data.threadId]);
    const { rows } = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/read'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(JSON.parse(shown.stdout));
    return { result, rows };
  };
  return { run, started };
}

type StandaloneHost = Awaited<ReturnType<typeof standaloneHost>>;

/**
 * A trusted `--platform` module: the standalone platform with the scripted
 * fixture as `provider::probe`, which makes `calls` one step each, then answers.
 */
async function trustedPlatformModule(
  provider: string,
  calls: readonly { readonly input: unknown; readonly toolId: string }[] = []
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bs-trusted-model-module-'));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const scripted = pathToFileURL(
    createRequire(import.meta.url).resolve('@brainstrike/agent-host/test-fixtures/scripted-model')
  ).href;
  const module = join(directory, 'trusted-platform.mjs');
  await writeFile(
    module,
    `import { createHostPlatform as standalone } from ${JSON.stringify(platform)};
import { scriptedToolSequence } from ${JSON.stringify(scripted)};
const fixture = scriptedToolSequence(${JSON.stringify(calls)});
const model = {
  doGenerate: (options) => fixture.doGenerate(options),
  doStream: (options) => fixture.doStream(options),
  modelId: 'probe',
  provider: ${JSON.stringify(provider)},
  specificationVersion: fixture.specificationVersion,
  supportedUrls: fixture.supportedUrls,
};
export const createHostPlatform = (options, startup, launch) =>
  standalone(options, startup, launch, { models: [{ budgets: 'openai::gpt-6-luna', model }] });
`
  );
  return module;
}

test('without the seam, --model resolves through the catalog and cannot name a trusted model', {
  timeout: 120_000,
}, async () => {
  const provider = await refusingProvider();
  const host = await standaloneHost({
    BRAINSTRIKE_OPENAI_API_KEY: 'trusted-model-fixture-key',
    OPENAI_BASE_URL: provider.baseUrl,
  });
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const catalog = await host.run('openai::gpt-6-luna');
  // The real OpenAI SDK sent the catalog model's request; the stand-in refused it.
  expect(catalog.result.code).toBe(1);
  expect(provider.requests.map(({ body, url }) => ({ model: body['model'], url }))).toContainEqual({
    model: 'gpt-6-luna',
    url: '/v1/responses',
  });
  expect(catalog.rows?.find((row) => row.event.type === 'run.started')?.event).toMatchObject({
    modelId: 'openai::gpt-6-luna',
  });
  const named = await host.run('trusted-fixture::probe');
  expect(named.result.code).toBe(1);
  expect(named.result.stderr).toMatch(/explicit canonical provider::model/u);
});

test('with the seam, the injected model runs under its own identity and no catalog model runs', {
  timeout: 120_000,
}, async () => {
  const provider = await refusingProvider();
  const module = await trustedPlatformModule('trusted-fixture');
  // No provider credential: the trusted model reads none.
  const host = await standaloneHost({ OPENAI_BASE_URL: provider.baseUrl }, module);
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const trusted = await host.run('trusted-fixture::probe');
  expect(trusted.result, trusted.result.stderr).toMatchObject({ code: 0 });
  const events = (trusted.rows ?? []).map((row) => row.event);
  expect(events.find((event) => event.type === 'run.started')).toMatchObject({
    modelId: 'trusted-fixture::probe',
    snapshot: {
      configuration: {
        intent: { modelConfiguration: { model: 'probe', provider: 'trusted-fixture' } },
      },
    },
  });
  const steps = events.filter((event) => event.type === 'model.step');
  expect(steps.length).toBeGreaterThan(0);
  for (const step of steps) {
    expect(step).toMatchObject({ model: { modelId: 'probe', provider: 'trusted-fixture' } });
  }
  expect(events.find((event) => event.type === 'run.finished')).toMatchObject({
    outcome: 'completed',
  });
  const catalog = await host.run('openai::gpt-6-luna');
  expect(catalog.result.code).toBe(1);
  expect(catalog.result.stderr).toMatch(/runs only the models its trusted composition supplies/u);
  expect(provider.requests).toEqual([]);
});

test('a trusted model that claims a catalog provider identity fails host start', {
  timeout: 120_000,
}, async () => {
  const host = await standaloneHost({}, await trustedPlatformModule('openai'));
  expect(host.started.code).toBe(1);
  expect(host.started.stderr).toMatch(/must not claim a catalog provider's identity/u);
});

/** The tool results the model received, as recorded on the thread's `model.step` events. */
function recordedToolResults(rows: Awaited<ReturnType<StandaloneHost['run']>>['rows']) {
  const toolResult = z.object({
    output: z.unknown(),
    toolCallId: z.string(),
    type: z.literal('tool-result'),
  });
  return (rows ?? []).flatMap(({ event }) =>
    event.type === 'model.step'
      ? event.messages.flatMap(
          (message) =>
            z
              .object({ content: z.array(z.unknown()), role: z.literal('tool') })
              .safeParse(message)
              .data?.content.flatMap((part) => toolResult.safeParse(part).data ?? []) ?? []
        )
      : []
  );
}

test('the standalone host searches its launch root with grepSearch', {
  timeout: 120_000,
}, async () => {
  const module = await trustedPlatformModule('trusted-fixture', [
    { input: { pattern: 'needle-2386' }, toolId: 'brainstrike_grepSearch' },
  ]);
  const host = await standaloneHost({}, module, {
    'haystack.txt': 'hay\nthe needle-2386 is here\nhay\n',
  });
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const searched = await host.run('trusted-fixture::probe');
  expect(searched.result, searched.result.stderr).toMatchObject({ code: 0 });
  // The model sees the launch root's matching file and line, found on disk by this host.
  expect(recordedToolResults(searched.rows)).toEqual([
    expect.objectContaining({
      output: { type: 'text', value: expect.stringMatching(/^haystack\.txt:2 \(1 match\)$/mu) },
      toolCallId: 'recorded-call-1',
    }),
  ]);
});

test('the standalone host inspects its launch root with the language server', {
  timeout: 120_000,
}, async () => {
  // lspInspect is a deferred tool: the model loads it by name, then calls it.
  const module = await trustedPlatformModule('trusted-fixture', [
    { input: { toolName: 'brainstrike_lspInspect' }, toolId: 'load_tool' },
    {
      input: { line: 2, match: 'answer', path: 'main.ts' },
      toolId: 'brainstrike_lspInspect',
    },
  ]);
  const host = await standaloneHost({}, module, {
    'main.ts': 'export const answer = 42;\nexport const doubled = answer * 2;\n',
  });
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const inspected = await host.run('trusted-fixture::probe');
  expect(inspected.result, inspected.result.stderr).toMatchObject({ code: 0 });
  // The model sees the symbol's type and its declaration, answered by a
  // language server this host started over its launch root and retired on stop.
  const result = recordedToolResults(inspected.rows).find(
    ({ toolCallId }) => toolCallId === 'recorded-call-2'
  );
  const text = z
    .object({ type: z.literal('text'), value: z.string() })
    .parse(result?.output, { reportInput: true }).value;
  expect(text).toMatch(/^lsp \| available=true\b/u);
  expect(text).toMatch(/^hover: .*const answer: 42/mu);
  expect(text).toMatch(/^definition \S*main\.ts:1 \| export const answer = 42;$/mu);
});
