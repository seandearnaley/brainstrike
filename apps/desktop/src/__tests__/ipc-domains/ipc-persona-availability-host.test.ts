import { projectModelCatalog } from '@brainstrike/assistant-contract';
import { beforeEach, expect, it, vi } from 'vitest';
import { createUserPersonasListHandler } from '../../ipc-user-personas-handlers';

const host = vi.hoisted(() => ({
  content: '---\ndescription: Embedding pin\nmodel: openai::text-embedding-3-small\n---\nBody.',
  dispose: vi.fn(),
  read: vi.fn(),
  readTools: vi.fn(async (): Promise<Record<string, { enabled: boolean; id: string }[]>> => ({})),
  ready: false,
}));
vi.mock('../../db-main', () => ({
  getDatabase: async () => {
    throw new Error('PG forbidden');
  },
}));
vi.mock('../../mcp/main-host-control', () => ({
  getMainMcpHostControl: () => ({ readTools: host.readTools }),
}));
vi.mock('../../assistant-server/provider-credentials', () => ({
  resolveProviderCredential: async () => ({ key: 'configured', type: 'api_key' }),
}));
vi.mock('../../assistant-server/node-fs-scan-deps', () => ({
  createNodeFsScanDeps: () => ({
    dispose: host.dispose,
    listDir: () => ({
      entries: [{ isDirectory: false, isFile: true, name: 'embedding.md' }],
      inspected: 1,
      truncated: false,
    }),
    readFile: () => ({ content: host.content, ok: true }),
  }),
}));

beforeEach(() => {
  host.ready = false;
  host.read.mockImplementation(async () => {
    if (!host.ready) {
      throw new Error('Persona availability requires the host model catalog');
    }
    return projectModelCatalog({ models: [], providers: [] });
  });
  host.content =
    '---\ndescription: Embedding pin\nmodel: openai::text-embedding-3-small\n---\nBody.';
  host.readTools.mockClear();
  host.read.mockClear();
  host.dispose.mockClear();
});

it('refuses a host check without its model catalog and disposes the scanner instead of returning unchecked success', async () => {
  await expect(
    createUserPersonasListHandler(
      { workspaceRoots: async () => ({ roots: [] }) },
      { read: host.read }
    )()
  ).rejects.toThrow('Persona availability requires the host model catalog');
  expect(host.dispose).toHaveBeenCalledOnce();
  expect(host.read).toHaveBeenCalledOnce();
});

it('reads the canonical model kind at the production IPC entry and rejects an embedding pin', async () => {
  host.ready = true;
  const result = await createUserPersonasListHandler(
    {
      workspaceRoots: async () => ({ roots: [] }),
    },
    { read: host.read }
  )();
  expect(host.read).toHaveBeenCalledOnce();
  expect(result.personas.find((persona) => persona.id === 'embedding')).toMatchObject({
    availability: {
      issues: [expect.objectContaining({ code: 'model-unsupported' })],
      status: 'blocked',
    },
  });
  expect(host.dispose).toHaveBeenCalledOnce();
});

it("reads MCP tool enablement from the host's tools, once per listing (BST-1930 c5e)", async () => {
  host.ready = true;
  host.content = '---\ndescription: Searches\nmode: worker\ntools: fixture.search\n---\nBody.';
  host.readTools.mockResolvedValueOnce({ fixture: [{ enabled: false, id: 'fixture.search' }] });

  const result = await createUserPersonasListHandler(
    {
      workspaceRoots: async () => ({ roots: [] }),
    },
    { read: host.read }
  )();

  expect(host.readTools).toHaveBeenCalledOnce();
  expect(result.personas.find((persona) => persona.id === 'embedding')).toMatchObject({
    availability: {
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'tool-disabled', toolId: 'fixture.search' }),
      ]),
    },
  });
});
