/**
 * The standalone platform's trusted model seam. Absent, `--model` resolves
 * through the canonical catalog to the real provider SDK, and no flag can name
 * a trusted model. Present (only through a trusted `--platform` module), the
 * injected model runs under its own identity, which `run.started` and each
 * `model.step` name, and no catalog model runs beside it.
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
const platform = pathToFileURL(fileURLToPath(new URL('../dist/platform.js', import.meta.url))).href;
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

async function standaloneHost(env: Readonly<Record<string, string>>, platformModule?: string) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-m3-trusted-model-data-'));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'bs-trusted-model-ws-')));
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

/** A trusted `--platform` module: the standalone platform with the scripted fixture as `provider::probe`. */
async function trustedPlatformModule(provider: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bs-trusted-model-module-'));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const scripted = pathToFileURL(
    createRequire(import.meta.url).resolve('@brainstrike/agent-host/test-fixtures/scripted-model')
  ).href;
  const module = join(directory, 'trusted-platform.mjs');
  await writeFile(
    module,
    `import { createHostPlatform as standalone } from ${JSON.stringify(platform)};
import { scriptedModel } from ${JSON.stringify(scripted)};
const fixture = scriptedModel();
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
