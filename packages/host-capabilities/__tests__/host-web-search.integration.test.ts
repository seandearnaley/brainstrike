// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiKeyAuthInput,
  createProviderNativeWebSearchTool,
} from '@brainstrike/agent/provider-runtime';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import {
  type AgentHost,
  attachAgentHost,
  type HostClient,
  type HostLogRow,
  type HostPlatform,
  type HostRunAdmission,
  type HostTool,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedToolSequence } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { createHostCapabilities } from '../src/capabilities.js';
import { createHostCredentials } from '../src/credentials.js';
import {
  createSharedNativeHostTools,
  ReadWorkspaceFileCursorRegistry,
} from '../src/native-tools/index.js';

const directories: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

type Override = 'allow' | 'ask' | 'deny' | undefined;

interface WebSearchHostOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly extraTools?: Readonly<Record<string, HostTool>>;
  readonly fetchImpl?: typeof fetch;
  readonly model: ReturnType<typeof scriptedToolSequence>;
  readonly override: () => Override;
  readonly provider: string;
  readonly storedTavilyKey?: string;
}

/** A host composed like production: host credentials, shared web search, Core's admission. */
async function startWebSearchHost(options: WebSearchHostOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'bs-m3-host-web-search-'));
  directories.push(directory);
  const credentialFile = join(directory, 'credentials.json');
  if (options.storedTavilyKey) {
    // Seeded through the host's own credential writer.
    const seed = createHostCredentials({ selection: { kind: 'file', path: credentialFile } });
    await seed.secrets().saveKey('tavily', options.storedTavilyKey);
    await seed.close();
  }
  let webSearchName = '';
  const host = await startAgentHost(
    { lifetime: 'persistent', root: join(directory, 'root') },
    async (startup): Promise<HostPlatform> => {
      const capabilities = await createHostCapabilities({
        env: options.env ?? {},
        launch: { credentialStore: { kind: 'file', path: credentialFile } },
        startup,
      });
      const shared = createSharedNativeHostTools({
        ids: [NATIVE_TOOL_ID.webSearch],
        readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
        resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
        runtime: { model: 'scripted', provider: options.provider },
        webSearch: {
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          resolveApiKey: capabilities.resolveTavilyApiKey,
        },
      });
      webSearchName =
        Object.entries(shared).find(
          ([, tool]) => tool.permissionToolId === NATIVE_TOOL_ID.webSearch
        )?.[0] ?? '';
      const tools = { ...shared, ...options.extraTools };
      // Production builds this with the run's resolved auth (production-platform.ts).
      const nativeWebSearch = createProviderNativeWebSearchTool(
        options.provider,
        apiKeyAuthInput('fixture-provider-key')
      ) as unknown as HostRunAdmission['nativeWebSearch'];
      return {
        admitRun: async () => ({
          configuration: { model: 'scripted', provider: options.provider },
          model: options.model,
          ...(nativeWebSearch ? { nativeWebSearch } : {}),
          snapshot: {
            configuration: {},
            maxSteps: 3,
            toolIdentities: Object.fromEntries(
              Object.entries(tools).map(([id, tool]) => [id, tool.identity])
            ),
          },
          tools,
        }),
        close: () => capabilities.close(),
        readPermissionPolicy: () => {
          const override = options.override();
          return {
            policies: DEFAULT_PERMISSION_POLICIES,
            yolo: false,
            ...(override ? { perToolOverrides: { [NATIVE_TOOL_ID.webSearch]: override } } : {}),
          };
        },
      };
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Look this up on the web.',
    threadId,
  });
  let rows: readonly HostLogRow[] = [];
  await expect
    .poll(async () => {
      rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      return rows.find(({ event }) => event.type === 'run.finished')?.event;
    })
    .toMatchObject({ outcome: 'completed' });
  return { rows, webSearchName };
}

/** The web search entry the model was offered on one step. */
function offeredWebSearch(
  model: ReturnType<typeof scriptedToolSequence>,
  step: number,
  name: string
): unknown {
  return model.doStreamCalls[step]?.tools?.find((tool) => tool.name === name);
}

test.for([
  { id: 'anthropic.web_search_20250305', provider: 'anthropic' },
  { id: 'openai.web_search', provider: 'openai' },
])('$provider: allow offers the provider search, ask keeps Tavily', async ({ id, provider }) => {
  for (const override of [undefined, 'ask'] as const) {
    const model = scriptedToolSequence([]);
    const { webSearchName } = await startWebSearchHost({
      model,
      override: () => override,
      provider,
    });
    expect(offeredWebSearch(model, 0, webSearchName)).toMatchObject(
      override === 'ask' ? { name: webSearchName, type: 'function' } : { id, type: 'provider' }
    );
  }
});

test('a mid-run deny removes the provider search from the next step', async () => {
  let override: Override;
  const probe: HostTool = {
    description: 'Changes the web search policy',
    execute: async () => {
      override = 'deny';
      return { changed: true };
    },
    identity: 'policy-probe',
    inputSchema: z.object({}),
    risk: 'read',
  };
  const model = scriptedToolSequence([{ input: {}, toolId: 'policy_probe' }]);
  const { webSearchName } = await startWebSearchHost({
    extraTools: { policy_probe: probe },
    model,
    override: () => override,
    provider: 'anthropic',
  });
  expect(model.doStreamCalls).toHaveLength(2);
  expect(offeredWebSearch(model, 0, webSearchName)).toMatchObject({
    id: 'anthropic.web_search_20250305',
    type: 'provider',
  });
  expect(offeredWebSearch(model, 1, webSearchName)).toBeUndefined();
});

test.for([
  { env: {}, expected: 'stored-tavily-key' },
  { env: { TAVILY_API_KEY: 'env-tavily-key' }, expected: 'env-tavily-key' },
])(
  'Tavily search authenticates from the host store; env wins ($expected)',
  async ({ env, expected }) => {
    const authorizations: (string | null)[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization'));
      return new Response(
        JSON.stringify({
          results: [
            { content: 'Host-owned search.', title: 'Result', url: 'https://example.com/a' },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 }
      );
    };
    // OpenRouter has no provider search, so the catalog tool runs in the host.
    const toolName = 'brainstrike_webSearch';
    const model = scriptedToolSequence([
      { input: { query: 'brainstrike host' }, toolId: toolName },
    ]);
    const { rows, webSearchName } = await startWebSearchHost({
      env,
      fetchImpl,
      model,
      override: () => undefined,
      provider: 'openrouter',
      storedTavilyKey: 'stored-tavily-key',
    });
    expect(webSearchName).toBe(toolName);
    expect(authorizations).toEqual([`Bearer ${expected}`]);
    expect(rows.find(({ event }) => event.type === 'effect.finished')?.event).toMatchObject({
      output: { available: true, count: 1, results: [{ url: 'https://example.com/a' }] },
    });
    expect(JSON.stringify(rows)).not.toContain(expected);
  }
);
