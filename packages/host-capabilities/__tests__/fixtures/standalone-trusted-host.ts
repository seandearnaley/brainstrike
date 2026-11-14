/**
 * The standalone host a trusted `--platform` module composes, started through
 * the production bin over a disposable data root and launch root. A scripted
 * trusted model makes each listed tool call one step, so a suite shows the
 * host's own workspace tools run over its launch root.
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
import { expect } from 'vitest';
import { z } from 'zod';

const bin = fileURLToPath(new URL('../../bin/brainstrike.mjs', import.meta.url));
const platform = pathToFileURL(
  fileURLToPath(new URL('../../src/platform.ts', import.meta.url))
).href;
/** What each test leaves behind; a suite drains it with `afterEach(drainCleanup)`. */
export const cleanup: (() => Promise<void>)[] = [];

/** Closes what the test opened, newest first. */
export async function drainCleanup(): Promise<void> {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
}

/** A loopback OpenAI stand-in that refuses every request and keeps what it was sent. */
export async function refusingProvider() {
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

export async function standaloneHost(
  env: Readonly<Record<string, string>>,
  platformModule?: string,
  files: Readonly<Record<string, string>> = {},
  /** Runs before `host start`, while nothing holds the data root. */
  prepare?: (paths: { readonly dataRoot: string; readonly workspace: string }) => Promise<void>
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
  await prepare?.({ dataRoot, workspace });
  const started = await command([
    'host',
    'start',
    '--workspace',
    workspace,
    ...(platformModule ? ['--platform', platformModule] : []),
  ]);
  /** The thread's log rows from `threads show`; a refused read fails with the CLI's own error. */
  const threadRows = async (threadId: string) => {
    const shown = await command(['threads', 'show', '--thread', threadId]);
    expect(shown, shown.stderr).toMatchObject({ code: 0 });
    return Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/read'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(JSON.parse(shown.stdout)).rows;
  };
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
    return { result, rows: await threadRows(identity.data.threadId) };
  };
  return { command, run, started, threadRows, workspace };
}

export type StandaloneHost = Awaited<ReturnType<typeof standaloneHost>>;

/**
 * A trusted `--platform` module: the standalone platform with the scripted
 * fixture as `provider::probe`, which makes `calls` one step each, then answers.
 */
export async function trustedPlatformModule(
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

/** The tool results the model received, as recorded on the thread's `model.step` events. */
export function recordedToolResults(rows: Awaited<ReturnType<StandaloneHost['run']>>['rows']) {
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
