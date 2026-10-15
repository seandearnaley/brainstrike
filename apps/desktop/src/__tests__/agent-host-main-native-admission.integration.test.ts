// @vitest-environment node
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRunAdmissionRequest } from '@brainstrike/agent-host';
import { DEFAULT_PERMISSION_POLICIES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW } from '@brainstrike/assistant-contract/context-budget';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

// Main's catalog and root reads answer from fixtures; no credential or HTTP is reachable.
const owner = vi.hoisted(() => ({
  credential: vi.fn(() => {
    throw new Error('Unexpected credential access in worktree tool control');
  }),
  // The skills scan's home tier, kept inside the test's own directory.
  home: '',
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => owner.home,
}));
vi.mock('../db-main', () => ({
  getDatabase: async () => {
    throw new Error('PGlite must not be opened by host admission');
  },
}));
vi.mock('../provider-api-key', () => ({ readProviderCredential: owner.credential }));
vi.mock('../ipc-mcp', () => ({
  readDesktopMcpHostSnapshot: async (runtime: { host: { snapshot(): unknown } }) =>
    structuredClone(runtime.host.snapshot()),
}));

import { PlatformClientConfigurationSchema } from '../agent-host-platform/platform-wire';
import { admissionCatalogFixture, admissionModelSnapshot } from './fixtures/admission-catalog';
import { desktopAdmission as createDesktopAdmission } from './fixtures/desktop-admission';
import lmStudioModels from './fixtures/lmstudio-v1-models.json';
import ollamaTags from './fixtures/ollama-0.32.14-api-tags.json';

const WORKTREE_TOOL_IDS = [NATIVE_TOOL_ID.listWorktrees, NATIVE_TOOL_ID.manageWorktree];
let directory = '';
const catalog = admissionCatalogFixture(() => [
  { displayName: 'A', id: 'root-a', path: join(directory, 'a') },
]);
function desktopAdmission(
  dependencies: Partial<Parameters<typeof createDesktopAdmission>[0]>,
  ...rest: Parameters<typeof createDesktopAdmission> extends [unknown, ...infer Rest] ? Rest : never
) {
  return createDesktopAdmission({ ...catalog.services, ...dependencies }, ...rest);
}

beforeEach(async () => {
  catalog.modelRead.mockImplementation(async () => admissionModelSnapshot());
  directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'bs-m3-worktree-tools-')));
  await fs.mkdir(join(directory, 'a'));
  owner.home = join(directory, 'home');
  await fs.mkdir(owner.home);
});
afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
  expect(owner.credential).not.toHaveBeenCalled();
});

function request(
  enabledNativeToolIds: readonly string[],
  selection: Record<string, unknown> = {},
  model: { readonly model: string; readonly provider: string } = {
    model: 'gpt-6-sol',
    provider: 'openai',
  }
): HostRunAdmissionRequest {
  const configuration = PlatformClientConfigurationSchema.parse({
    ...selection,
    agentLoop: { inputTokenLimit: 7000, maxSteps: 3 },
    enabledNativeToolIds,
    memoryOptions: {
      lastMessages: 1,
      workingMemory: { enabled: false, scope: 'thread', template: '' },
    },
    memorySettings: {
      observationalMemory: {
        enabled: false,
        messageTokens: 1234,
        modelTarget: 'auto',
        observationTokens: 2345,
        retrievalMode: 'messages',
        scope: 'thread',
      },
      semanticRecall: {
        embeddingModelTarget: null,
        enabled: false,
        messageRange: 0,
        scope: 'thread',
        topK: 2,
      },
    },
    modelConfiguration: model,
    permissionPolicy: { policies: DEFAULT_PERMISSION_POLICIES, yolo: false },
    skillsPreference: { disabledSkillKeys: [], masterEnabled: false },
    ...selection,
    workspaceInstructionsPreference: { masterEnabled: false, oversizedOptInByRootId: {} },
  });
  return {
    configuration: z.record(z.string(), z.json()).parse(configuration),
    modelId: `${model.provider}::${model.model}`,
    runId: 'host-run',
    signal: new AbortController().signal,
    threadId: 'host-thread',
  };
}

test('Main serves a host run’s worktree calls through its worktree service under the host run identity', async () => {
  const service = {
    archive: vi.fn(),
    create: vi.fn(async () => ({
      ok: true as const,
      value: {
        setup: { reason: null, status: 'none' },
        worktree: { branch: 'bs/fox', id: 'wt-9', path: '/managed/fox' },
      },
    })),
    list: vi.fn(async () => ({ ok: true as const, value: [] })),
  };
  const worktrees = desktopAdmission({
    resolveForgeService: () => null,
    resolveWorktreeService: () => service as never,
  }).hostTools?.worktrees?.({ runId: 'host-run', threadId: 'host-thread' });
  if (!worktrees) {
    throw new Error('Main served no worktree calls');
  }
  await expect(worktrees.list()).resolves.toEqual({ ok: true, value: [] });
  await expect(
    worktrees.create({ baseRef: 'HEAD', branch: 'bs/fox', name: 'fox', rootId: 'root-a' })
  ).resolves.toMatchObject({ ok: true, value: { worktree: { id: 'wt-9' } } });
  // Provenance comes from the host run, never from tool input.
  expect(service.create).toHaveBeenCalledWith({
    baseRef: 'HEAD',
    branch: { name: 'bs/fox' },
    createdBy: 'agent',
    name: 'fox',
    rootId: 'root-a',
    runId: 'host-run',
    threadId: 'host-thread',
  });
});

test('a host thread is not offered worktree tools while Main has no worktree service', async () => {
  const captured = await desktopAdmission({
    resolveWorktreeService: () => null,
  }).readConfiguration(request([...WORKTREE_TOOL_IDS, NATIVE_TOOL_ID.globWorkspace]));
  try {
    const advertised = Object.values(captured.tools).map((tool) => tool.permissionToolId);
    expect(advertised).toContain(NATIVE_TOOL_ID.globWorkspace);
    expect(advertised).not.toContain(NATIVE_TOOL_ID.listWorktrees);
    expect(advertised).not.toContain(NATIVE_TOOL_ID.manageWorktree);
  } finally {
    await captured.close();
  }
});

test('Main admits the focused folder, and no checked files, to the host’s native runtime (BST-2019)', async () => {
  const workspaceContext = {
    files: [
      {
        approxTokens: 3,
        outputApproxTokens: null,
        path: 'notes.txt',
        ranges: [{ endLine: 1, isActive: true, startLine: 1 }],
        rootId: 'root-a',
      },
    ],
    includeProjectTree: false,
    projectTreeApproxTokens: null,
    projectTreeTokenCountLoading: false,
    selectedOutputApproxTokens: null,
    selectedSourceApproxTokens: null,
    tokenBudget: 321,
  };
  // An intent captured before checked files were retired still parses; nothing reads it.
  const captured = await desktopAdmission({}).readConfiguration(
    request([NATIVE_TOOL_ID.readWorkspaceContext], {
      selectionFolderId: 'root-a',
      workspaceContext,
    })
  );
  try {
    expect(captured.nativeRuntime).toMatchObject({ selectionFolderId: 'root-a' });
    expect(captured.nativeRuntime).not.toHaveProperty('selectionFilePaths');
    expect(captured.nativeRuntime).not.toHaveProperty('workspaceContext');
    expect(captured.nativeRuntime).not.toHaveProperty('attachedRootIds');
  } finally {
    await captured.close();
  }
});

test('Main reconciles a host command’s worktrees under the host run’s identity', async () => {
  const service = {
    list: vi.fn(async () => ({ ok: true as const, value: [{ path: '/repo/.worktrees/fox' }] })),
    reconcileFromShell: vi.fn(async () => ({
      ok: true as const,
      value: { adopted: [], likelyMoves: [], vanishedLedgerIds: [] },
    })),
    repositoryContextForRoot: vi.fn(async () => ({
      ok: true as const,
      value: { commonDir: '/repo/.git' },
    })),
  };
  const shell = desktopAdmission({
    resolveForgeService: () => null,
    resolveWorktreeService: () => service as never,
  }).hostTools?.shell;
  if (!shell) {
    throw new Error('Main offers no shell correlation');
  }
  await expect(shell.worktreePaths()).resolves.toEqual(['/repo/.worktrees/fox']);
  shell.completed({
    command: 'git worktree add ../fox',
    precedingWorktreePaths: ['/repo/.worktrees/fox'],
    rootId: 'root-a',
    runId: 'host-run',
    threadId: 'host-thread',
  });
  await vi.waitFor(() =>
    expect(service.reconcileFromShell).toHaveBeenCalledWith({
      precedingWorktreePaths: new Set(['/repo/.worktrees/fox']),
      repoCommonDir: '/repo/.git',
      runId: 'host-run',
      threadId: 'host-thread',
    })
  );
  expect(service.repositoryContextForRoot).toHaveBeenCalledWith('root-a');
});

test('Main admits one scan’s enabled skills to a host run, and none to the built-in local provider', async () => {
  const skill = join(directory, 'a', '.brainstrike', 'skills', 'demo-skill');
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(
    join(skill, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: Says hello from a skill.\n---\nGreet the user.\n'
  );
  const skills = { skillsPreference: { disabledSkillKeys: [], masterEnabled: true } };
  const admit = async (model: { readonly model: string; readonly provider: string }) => {
    const captured = await desktopAdmission({}).readConfiguration(request([], skills, model));
    try {
      return {
        admitted: captured.nativeRuntime.skills?.map((entry) => entry.name),
        tools: Object.values(captured.tools).map((tool) => tool.permissionToolId),
      };
    } finally {
      await captured.close();
    }
  };

  const hosted = await admit({ model: 'gpt-6-sol', provider: 'openai' });
  expect(hosted.admitted).toEqual(['demo-skill']);
  expect(hosted.tools).toEqual(expect.arrayContaining(['skill', 'skill_read', 'skill_search']));

  const local = await admit({ model: 'onnx-community/gemma-4-E2B-it-ONNX', provider: 'local' });
  expect(local.admitted).toBeUndefined();
  expect(local.tools).not.toEqual(expect.arrayContaining(['skill']));
  expect(local.tools.filter((id) => id?.startsWith('skill'))).toEqual([]);
});

// Recorded 2026-10-08 from a local Ollama 0.32.14 (`GET /api/tags`) and LM Studio (`GET /v1/models`).
const OLLAMA_CHAT_MODELS = ollamaTags.models
  .filter((model) => model.capabilities.includes('completion'))
  .map((model) => model.name);
const LM_STUDIO_CHAT_MODELS = lmStudioModels.data
  .map((model) => model.id)
  .filter((id) => !id.startsWith('text-embedding-'));

test('a model the local Ollama or LM Studio runtime lists is admitted without a catalog row', async () => {
  // Runtime-discovered models live in neither the models table nor the static catalog.

  catalog.modelRead.mockRejectedValue(
    new Error('A local runtime model has no catalog row to read')
  );
  expect(OLLAMA_CHAT_MODELS).toEqual(
    expect.arrayContaining(['gemma4:31b', 'glm-4.7-flash:latest', 'qwen3:30b'])
  );
  for (const [provider, model] of [
    ...OLLAMA_CHAT_MODELS.map((id) => ['ollama', id] as const),
    ...LM_STUDIO_CHAT_MODELS.map((id) => ['lmstudio', id] as const),
  ]) {
    const captured = await desktopAdmission({}).readConfiguration(
      request([], { agentLoop: { maxSteps: 3 } }, { model, provider })
    );
    try {
      // Budgeted at the conservative window the picker declares for discovered models.
      expect({ contextWindow: captured.contextWindow, model: captured.configuration }).toEqual({
        contextWindow: DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW,
        model: { model, provider },
      });
    } finally {
      await captured.close();
    }
  }
});

test('the auto observer is the first auto candidate the model catalog has enabled', async () => {
  const eligible =
    vi.fn<(pairs: readonly unknown[]) => { providerId: string; modelId: string }[]>();

  catalog.modelRead.mockImplementation(async () => {
    const snapshot = admissionModelSnapshot();
    const enabled = new Set(eligible([]).map((pair) => `${pair.providerId}/${pair.modelId}`));
    return {
      ...snapshot,
      models: snapshot.models.map((model) => ({
        ...model,
        isEnabled:
          model.id === 'anthropic/claude-sonnet-4.6' ||
          enabled.has(`${model.providerId}/${model.id}`) ||
          model.providerId !== 'openrouter',
      })),
      providers: snapshot.providers.map((provider) => ({
        ...provider,
        isEnabled: provider.id === 'openrouter',
      })),
    };
  });
  const memory = async (target: { model: string; provider: string }) => {
    const captured = await desktopAdmission({}).readConfiguration(
      request(
        [],
        {
          memorySettings: {
            observationalMemory: {
              enabled: true,
              messageTokens: 1234,
              modelTarget: 'auto',
              observationTokens: 2345,
              retrievalMode: 'off',
              scope: 'thread',
            },
            semanticRecall: {
              embeddingModelTarget: null,
              enabled: false,
              messageRange: 0,
              scope: 'thread',
              topK: 2,
            },
          },
        },
        target
      )
    );
    try {
      return captured.memory;
    } finally {
      await captured.close();
    }
  };
  const observer = async () =>
    (await memory({ model: 'anthropic/claude-sonnet-4.6', provider: 'openrouter' })).settings
      .observationalMemory;

  // OpenRouter's first auto candidate ships catalog-disabled; the enabled one after it observes.
  eligible.mockReturnValue([{ modelId: 'google/gemini-3.5-flash-lite', providerId: 'openrouter' }]);
  await expect(observer()).resolves.toMatchObject({
    enabled: true,
    modelTarget: 'openrouter/google/gemini-3.5-flash-lite',
  });
  // No enabled candidate: observation waits, disabled, as the settings resolver reports it.
  eligible.mockReturnValue([]);
  await expect(observer()).resolves.toMatchObject({ enabled: false });
  // Why it waits, as legacy's settings resolver names it: the chat provider has
  // auto candidates but none is enabled, or it has no auto candidate at all.
  await expect(
    memory({ model: 'anthropic/claude-sonnet-4.6', provider: 'openrouter' })
  ).resolves.toMatchObject({ observerAwaiting: 'model-not-eligible' });
  await expect(
    memory({ model: 'anthropic.claude-fable-5', provider: 'bedrock' })
  ).resolves.toMatchObject({ observerAwaiting: 'no-hosted-chat-provider' });
});
