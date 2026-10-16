// @vitest-environment node
/**
 * LIVE-loop coverage for the desktop native tools on the PRODUCTION path.
 *
 * One real host run drives the real AI SDK loop (`startAgentHost` →
 * `core-run-execution`'s `streamText`) against the real native executor fold
 * (`_host-native-tools`, i.e. `SHARED_NATIVE_TOOL_EXECUTORS` plus the desktop
 * executors) bound through the real `createAgentHostToolBindings`. Only the
 * language model is scripted (`scriptedToolSequence` — no API key, no network).
 *
 * This replaces the six per-tool `*-live-loop` suites that drove the retired
 * Mastra agent loop (ADR-0022). It is deliberately ONE run over FOUR tools
 * rather than four runs: the binding hop is a single loop over
 * `toolNameMap`, so what is per-tool here is each tool's own observable
 * outcome, not a fresh mechanism. Each tool's behavioural edge cases stay in
 * its own suite as direct `execute` calls, which need no loop at all.
 *
 * What only this file proves: the host advertises each native tool under its
 * sanitized provider name, a model call on that name reaches the tool's REAL
 * execute, the real side effect lands on disk, and the result is committed to
 * the thread log where the conversation reads it.
 */
import { randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildNativeToolRiskMap,
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  type RuntimeData,
} from '@brainstrike/agent';
import {
  type AgentHost,
  attachAgentHost,
  createAgentHostToolBindings,
  type HostClient,
  startAgentHost,
} from '@brainstrike/agent-host';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { scriptedToolSequence } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { foldHostRuns } from '@brainstrike/agent-host/thread-view';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import type { WebSearchToolDependencies } from '@brainstrike/host-capabilities/native-tools';
import { getAdjustedTimeout } from '@brainstrike/test-utils';
import { afterEach, expect, test, vi } from 'vitest';
import { disposeLiveChildProcesses } from '../assistant-server/execute-command-tool';
import { buildHostNativeTools } from './assistant-server/_host-native-tools';
import { singleRootRuntime } from './assistant-server/_tool-test-helpers';

/** A real host, real tool executes and a real subprocess, on a loaded machine. */
const TEST_TIMEOUT_MS = getAdjustedTimeout('performance');

const TOOL_IDS = [
  'brainstrike.writeWorkspaceFile',
  'brainstrike.stringReplaceWorkspaceFile',
  'brainstrike.globWorkspace',
  'brainstrike.executeCommand',
] as const;

const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
const directories: string[] = [];

afterEach(async () => {
  await disposeLiveChildProcesses();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fsPromises.rm(directory, { force: true, recursive: true }))
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  // realpath: the shell tool resolves its cwd, and macOS /var is a symlink.
  const created = await fsPromises.realpath(
    await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix))
  );
  directories.push(created);
  return created;
}

test(
  'the host loop advertises each native tool and dispatches it to its real execute',
  async () => {
    const root = await temporaryDirectory('bs-host-live-native-root-');
    const workspace = await temporaryDirectory('bs-host-live-native-workspace-');

    // The glob fixture: two matches plus three files the ignore policy excludes.
    await fsPromises.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fsPromises.mkdir(path.join(workspace, 'node_modules', 'left-pad'), { recursive: true });
    await fsPromises.mkdir(path.join(workspace, 'dist'), { recursive: true });
    await fsPromises.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fsPromises.writeFile(path.join(workspace, 'src', 'main.test.ts'), 'test("a",()=>{});\n');
    await fsPromises.writeFile(
      path.join(workspace, 'node_modules', 'left-pad', 'index.test.ts'),
      'test("dep",()=>{});\n'
    );
    await fsPromises.writeFile(path.join(workspace, 'dist', 'bundle.test.ts'), 'noop\n');
    await fsPromises.writeFile(path.join(workspace, '.git', 'config.test.ts'), 'noop\n');

    // The shell tool's side-effect marker, written by a real subprocess.
    const marker = path.join(workspace, 'ran.marker');
    const fixture = path.join(workspace, 'live-command.cjs');
    await fsPromises.writeFile(
      fixture,
      [
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(marker)}, 'hello-from-shell\\n');`,
        "process.stdout.write('done\\n');",
      ].join('\n'),
      'utf8'
    );
    const command =
      process.platform === 'win32'
        ? 'echo hello-from-shell>ran.marker & echo done'
        : `"${process.execPath}" "${fixture}"`;

    const risk = buildNativeToolRiskMap();
    const tools = buildHostNativeTools(singleRootRuntime(workspace), { ids: TOOL_IDS });
    const bindings = createAgentHostToolBindings({
      bindings: Object.fromEntries(
        TOOL_IDS.map((id) => [id, { identity: id, risk: risk[id] ?? 'read' }])
      ),
      resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
      tools,
    });

    /** The sanitized provider name the host advertises for a catalog id. */
    function advertised(id: string): string {
      const name = [...bindings.toolNameMap].find(([, canonical]) => canonical === id)?.[0];
      if (!name) {
        throw new Error(`The host advertised no provider name for ${id}`);
      }
      return name;
    }

    // Each call names the tool by the name the HOST advertises, exactly as a
    // provider would: a sanitizer regression breaks this before any assertion.
    const model = scriptedToolSequence([
      {
        input: { content: 'export const retries = 3;\n', path: '/src/config.ts' },
        toolId: advertised('brainstrike.writeWorkspaceFile'),
      },
      {
        input: {
          newStr: 'export const retries = 5;',
          oldStr: 'export const retries = 3;',
          path: '/src/config.ts',
        },
        toolId: advertised('brainstrike.stringReplaceWorkspaceFile'),
      },
      { input: { pattern: '**/*.test.ts' }, toolId: advertised('brainstrike.globWorkspace') },
      { input: { command }, toolId: advertised('brainstrike.executeCommand') },
    ]);

    const host = await startAgentHost(
      { lifetime: 'persistent', root },
      {
        close: async () => undefined,
        // Four tool steps plus the closing text turn.
        maxSteps: 8,
        readPermissionPolicy: () => ({
          policies: {
            ...DEFAULT_PERMISSION_POLICIES,
            edit: 'allow',
            execute: 'allow',
            read: 'allow',
          },
          yolo: false,
        }),
        resolveModel: async () => model,
        tools: bindings.tools,
      }
    );
    hosts.push(host);
    const client = await attachAgentHost(host.record);
    clients.push(client);

    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    await client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Write the config, bump retries, list the test files, then run the fixture.',
      threadId,
    });

    let committed: readonly HostLogRow[] = [];
    await expect
      .poll(
        async () => {
          committed = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
          return committed.at(-1)?.event.type;
        },
        // A real subprocess and four real tool executes, on a loaded machine.
        { interval: 50, timeout: getAdjustedTimeout('heavy') }
      )
      .toBe('run.finished');

    const [run] = foldHostRuns(committed);
    if (!run) {
      throw new Error('The host committed no run');
    }
    expect(run.status).toBe('completed');
    // Every advertised tool was dispatched: four committed results, in order.
    expect(run.results).toHaveLength(4);

    const [write, replace, glob, shell] = run.results.map(({ output }) => JSON.stringify(output));

    // writeWorkspaceFile: a real file landed with the real byte count.
    expect(write).toContain('/src/config.ts');
    expect(write).toContain('"created":true');

    // stringReplaceWorkspaceFile: the matched line changed and nothing else did.
    expect(replace).toContain('"replaced":true');
    expect(await fsPromises.readFile(path.join(workspace, 'src', 'config.ts'), 'utf8')).toBe(
      'export const retries = 5;\n'
    );

    // globWorkspace: the real FS walk matched, and the ignore policy excluded the rest.
    expect(glob).toContain('src/main.test.ts');
    expect(glob).not.toContain('node_modules');
    expect(glob).not.toContain('dist/bundle.test.ts');
    expect(glob).not.toContain('.git/config.test.ts');

    // executeCommand: the real subprocess ran, and its side effect is on disk.
    expect(shell).toContain('done');
    expect(await fsPromises.readFile(marker, 'utf8')).toContain('hello-from-shell');

    // The model's closing answer is committed where the conversation reads it.
    expect(run.text).toContain('Host run completed.');
  },
  TEST_TIMEOUT_MS
);

/**
 * The webSearch tool over the same loop, with Tavily's fetch and the host's key
 * owner stubbed through injected dependencies — no network, no keychain.
 *
 * The load-bearing assertions here are on `prompts`: what the NEXT provider
 * request carries. That is the model-facing projection
 * (`applyToolModelOutputProjections`, which `createAgentHostToolBindings`
 * applies), and it is the only place the secret key's absence can be checked
 * against what the model actually sees rather than against the raw result.
 */
async function runWebSearch(
  webSearch: WebSearchToolDependencies
): Promise<{ readonly prompts: unknown[]; readonly results: string }> {
  const root = await temporaryDirectory('bs-host-live-web-search-');
  const tools = buildHostNativeTools({ provider: 'openrouter' } as RuntimeData, {
    ids: ['brainstrike.webSearch'],
    webSearch,
  });
  const bindings = createAgentHostToolBindings({
    bindings: { 'brainstrike.webSearch': { identity: 'brainstrike.webSearch', risk: 'read' } },
    resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
    tools,
  });
  const advertised = [...bindings.toolNameMap].find(
    ([, canonical]) => canonical === 'brainstrike.webSearch'
  )?.[0];
  if (!advertised) {
    throw new Error('The host advertised no provider name for brainstrike.webSearch');
  }
  const prompts: unknown[] = [];
  const model = scriptedToolSequence(
    [{ input: { query: 'how to cancel fetch' }, toolId: advertised }],
    prompts as Parameters<typeof scriptedToolSequence>[1]
  );
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 4,
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, read: 'allow' },
        yolo: false,
      }),
      resolveModel: async () => model,
      tools: bindings.tools,
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'how do I cancel a fetch?',
    threadId,
  });
  let committed: readonly HostLogRow[] = [];
  await expect
    .poll(
      async () => {
        committed = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
        return committed.at(-1)?.event.type;
      },
      // A real subprocess and four real tool executes, on a loaded machine.
      { interval: 50, timeout: getAdjustedTimeout('heavy') }
    )
    .toBe('run.finished');
  const [run] = foldHostRuns(committed);
  if (!run) {
    throw new Error('The host committed no run');
  }
  expect(run.status).toBe('completed');
  expect(run.results).toHaveLength(1);
  return { prompts, results: JSON.stringify(run.results.map(({ output }) => output)) };
}

const SECRET_TAVILY_KEY = 'tvly-SECRET-host-live-loop';

test(
  'the host loop projects webSearch results to the model without the key',
  async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        json: () =>
          Promise.resolve({
            results: [
              {
                content: 'AbortController lets you abort fetch requests.',
                title: 'AbortController - MDN',
                url: 'https://mdn.example/AbortController',
              },
              {
                content: 'Pass signal to fetch to make it cancellable.',
                title: 'fetch signal',
                url: 'https://mdn.example/fetch',
              },
            ],
          }),
        ok: true,
        status: 200,
      } as Response)
    );
    const resolveApiKey = vi.fn(() => Promise.resolve(SECRET_TAVILY_KEY));
    const { prompts, results } = await runWebSearch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveApiKey,
    });

    // The stubbed Tavily fetch ran through the real tool execute, once.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(resolveApiKey).toHaveBeenCalledTimes(1);
    expect(results).toContain('https://mdn.example/AbortController');
    expect(results).toContain('https://mdn.example/fetch');

    const requests = JSON.stringify(prompts);
    expect(requests).toContain('web-search | status=available | shown=2/2');
    expect(requests).toContain('url: \\"https://mdn.example/AbortController\\"');
    // The raw envelope flag is projected away rather than sent verbatim.
    expect(requests).not.toContain('\\"available\\":true');
    // The secret key reaches neither the committed result nor the provider.
    expect(results).not.toContain(SECRET_TAVILY_KEY);
    expect(requests).not.toContain(SECRET_TAVILY_KEY);
  },
  TEST_TIMEOUT_MS
);

test(
  'the host loop completes when webSearch has no key, without calling out',
  async () => {
    const fetchImpl = vi.fn();
    const { results } = await runWebSearch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveApiKey: () => Promise.resolve(undefined),
    });

    // Unavailable is a NON-FATAL tool result: the run completed (asserted in
    // runWebSearch) and the model is told why rather than the run failing.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(results).toContain('Tavily API key');
  },
  TEST_TIMEOUT_MS
);
