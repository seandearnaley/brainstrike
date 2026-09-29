import { beforeEach, expect, it, vi } from 'vitest';
import { createUserPersonasListHandler } from '../../ipc-user-personas-handlers';

const host = vi.hoisted(() => ({
  dispose: vi.fn(),
  query: vi.fn(async (sql: string) => ({
    rows: sql.includes('FROM models')
      ? [{ id: 'text-embedding-3-small', providerId: 'openai', type: 'embedding' }]
      : [],
  })),
  ready: false,
}));
vi.mock('../../db-main', () => ({
  getDatabase: async () => (host.ready ? { query: host.query } : null),
}));
vi.mock('@brainstrike/agent', () => ({ mcpToolRegistry: { getAllTools: () => ({}) } }));
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
    readFile: () => ({
      content: '---\ndescription: Embedding pin\nmodel: openai::text-embedding-3-small\n---\nBody.',
      ok: true,
    }),
  }),
}));

beforeEach(() => {
  host.ready = false;
});

it('refuses a host check without its database and disposes the scanner instead of returning unchecked success', async () => {
  await expect(createUserPersonasListHandler()()).rejects.toThrow(
    'Persona availability requires the host model catalog'
  );
  expect(host.dispose).toHaveBeenCalledOnce();
  expect(host.query).not.toHaveBeenCalled();
});

it('reads the persisted model kind at the production IPC entry and rejects an embedding pin', async () => {
  host.ready = true;
  const result = await createUserPersonasListHandler()();
  expect(host.query).toHaveBeenCalledWith(expect.stringContaining("capabilities->>'type'"));
  expect(result.personas.find((persona) => persona.id === 'embedding')).toMatchObject({
    availability: {
      issues: [expect.objectContaining({ code: 'model-unsupported' })],
      status: 'blocked',
    },
  });
  expect(host.dispose).toHaveBeenCalledOnce();
});
