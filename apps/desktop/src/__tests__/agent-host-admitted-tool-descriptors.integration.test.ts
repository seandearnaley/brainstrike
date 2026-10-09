// @vitest-environment node
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRunAdmissionRequest } from '@brainstrike/agent-host';
import {
  DEFAULT_PERMISSION_POLICIES,
  DESKTOP_NATIVE_TOOL_IDS,
} from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

// Main's catalog and root reads answer from fixtures; no credential or HTTP is reachable.
const owner = vi.hoisted(() => ({
  credential: vi.fn(() => {
    throw new Error('Unexpected credential access in tool descriptor admission');
  }),
  home: '',
  // The tool builders Main's admission loaded, if any: the desktop fold, its
  // executor map and the host-tool bindings.
  loaded: new Set<string>(),
  query: vi.fn(),
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => owner.home,
}));
vi.mock('@brainstrike/file-explorer-ui/preview', () => ({
  useWorkspaceContextCurationStore: { getState: () => ({ contextSnapshot: null }) },
}));
vi.mock('../db-main', () => ({ getDatabase: async () => ({ query: owner.query }) }));
vi.mock('../provider-api-key', () => ({ readProviderCredential: owner.credential }));
vi.mock('../ipc-mcp', () => ({
  readDesktopMcpHostSnapshot: async (runtime: { host: { snapshot(): unknown } }) =>
    structuredClone(runtime.host.snapshot()),
}));
vi.mock('../assistant-server/assistant-tools', async (importOriginal) => {
  owner.loaded.add('assistant-tools');
  return await importOriginal();
});
vi.mock('../assistant-server/native-tool-executors', async (importOriginal) => {
  owner.loaded.add('native-tool-executors');
  return await importOriginal();
});
vi.mock('../agent-host-tool-bindings', async (importOriginal) => {
  owner.loaded.add('agent-host-tool-bindings');
  return await importOriginal();
});

import { PlatformClientConfigurationSchema } from '../agent-host-platform/platform-wire';
import { productionDesktopCapabilities } from '../agent-host-platform/production-desktop-capabilities';
// Recorded from these admissions through Main's tool builders, before Main stopped building tools.
import recorded from './fixtures/admitted-tool-descriptors.json';

let directory = '';

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'bs-m3-tool-descriptors-')));
  await fs.mkdir(join(directory, 'a'));
  owner.home = join(directory, 'home');
  await fs.mkdir(owner.home);
  const skill = join(directory, 'a', '.brainstrike', 'skills', 'demo-skill');
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(
    join(skill, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: Says hello from a skill.\n---\nGreet the user.\n'
  );
  owner.query.mockImplementation(async (sql: string, params: readonly unknown[]) => {
    if (sql.includes('JOIN providers')) {
      return { rows: [] };
    }
    if (sql.includes('FROM models')) {
      return { rows: [{ isEnabled: true, providerId: params[1] }] };
    }
    if (sql.includes('FROM roots')) {
      return { rows: [{ displayName: 'A', id: 'root-a', path: join(directory, 'a') }] };
    }
    throw new Error('Unexpected owner query in tool descriptor admission');
  });
});
afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
  expect(owner.credential).not.toHaveBeenCalled();
});

const HOSTED = { model: 'gpt-6-sol', provider: 'openai' } as const;
const LOCAL = { model: 'onnx-community/gemma-4-E2B-it-ONNX', provider: 'local' } as const;

/** Every catalog tool enabled, so each admission shows exactly what its own rules keep. */
function request(
  model: { readonly model: string; readonly provider: string },
  options: { readonly planMode?: boolean; readonly skills?: boolean } = {}
): HostRunAdmissionRequest {
  const configuration = PlatformClientConfigurationSchema.parse({
    agentLoop: { inputTokenLimit: 7000, maxSteps: 3 },
    enabledNativeToolIds: [...DESKTOP_NATIVE_TOOL_IDS],
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
    skillsPreference: { disabledSkillKeys: [], masterEnabled: options.skills === true },
    workspaceInstructionsPreference: { masterEnabled: false, oversizedOptInByRootId: {} },
  });
  return {
    configuration: z.record(z.string(), z.json()).parse(configuration),
    modelId: `${model.provider}::${model.model}`,
    ...(options.planMode ? { planMode: true } : {}),
    runId: 'host-run',
    signal: new AbortController().signal,
    threadId: 'host-thread',
  };
}

const worktreeService = {
  list: async () => ({ ok: true as const, value: [] }),
};

const ADMISSIONS = {
  hosted: { request: request(HOSTED, { skills: true }), worktrees: true },
  local: { request: request(LOCAL), worktrees: true },
  'no-worktree-service': { request: request(HOSTED), worktrees: false },
  'plan-mode': { request: request(HOSTED, { planMode: true, skills: true }), worktrees: true },
} as const;

test('Main describes each admission’s tools exactly as recorded from real admissions', async () => {
  const observed: Record<string, unknown> = {};
  for (const [name, admission] of Object.entries(ADMISSIONS)) {
    const captured = await productionDesktopCapabilities({
      resolveForgeService: () => null,
      resolveWorktreeService: () => (admission.worktrees ? (worktreeService as never) : null),
    }).readConfiguration(admission.request);
    try {
      observed[name] = captured.tools;
    } finally {
      await captured.close();
    }
  }
  expect(observed).toEqual(recorded);
});

test('Main’s admission loads none of the tool builders: it describes, the host executes', async () => {
  const captured = await productionDesktopCapabilities({
    resolveForgeService: () => null,
    resolveWorktreeService: () => worktreeService as never,
  }).readConfiguration(ADMISSIONS.hosted.request);
  await captured.close();
  expect([...owner.loaded]).toEqual([]);
});
