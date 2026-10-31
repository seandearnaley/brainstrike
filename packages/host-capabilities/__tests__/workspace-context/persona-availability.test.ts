/**
 * Settings › Subagents' host checks (`workspace/personas`): each persona is
 * checked against the host's model catalog, MCP tools and credentials, and a
 * check that cannot run fails the listing instead of reporting unchecked success.
 */
import { expect, it, vi } from 'vitest';
import {
  discoverPersonas,
  type PersonaAvailabilityReads,
} from '../../src/workspace-context/workspace-discovery.ts';

const signal = new AbortController().signal;

/** One persona file in the home tier, through the scan's bounded reader. */
function personaFs(content: string) {
  const dispose = vi.fn();
  return {
    dispose,
    fs: () => ({
      dispose,
      listDir: (absDir: string) =>
        absDir.endsWith('/.brainstrike/agents')
          ? {
              entries: [{ isDirectory: false, isFile: true, name: 'profile.md' }],
              inspected: 1,
              truncated: false,
            }
          : null,
      readFile: () => ({ content, ok: true as const }),
    }),
  };
}

function reads(overrides: Partial<PersonaAvailabilityReads> = {}): PersonaAvailabilityReads {
  return {
    catalogModel: async () => ({ type: 'llm' }),
    mcpTools: async () => new Map(),
    readCredential: async () => ({ key: 'configured', type: 'api_key' }),
    ...overrides,
  };
}

async function listProfile(content: string, availability: PersonaAvailabilityReads) {
  const scan = personaFs(content);
  const result = await discoverPersonas(
    { availability, fs: scan.fs, homedir: () => '/home/user', roots: async () => [] },
    signal
  );
  return { profile: result.personas.find((persona) => persona.id === 'profile'), scan };
}

it('refuses the listing when the model catalog cannot answer, and closes the scanner', async () => {
  const scan = personaFs('---\ndescription: Pinned\nmodel: openai::gpt-6-luna\n---\nBody.');
  await expect(
    discoverPersonas(
      {
        availability: reads({
          catalogModel: async () => {
            throw new Error('The host model catalog is unavailable');
          },
        }),
        fs: scan.fs,
        homedir: () => '/home/user',
        roots: async () => [],
      },
      signal
    )
  ).rejects.toThrow('The host model catalog is unavailable');
  expect(scan.dispose).toHaveBeenCalledOnce();
});

it("blocks a persona pinned to an embedding model by the catalog's model type", async () => {
  const { profile, scan } = await listProfile(
    '---\ndescription: Embedding pin\nmodel: openai::text-embedding-3-small\n---\nBody.',
    reads({ catalogModel: async () => ({ type: 'embedding' }) })
  );
  expect(profile).toMatchObject({
    availability: {
      issues: [expect.objectContaining({ code: 'model-unsupported' })],
      status: 'blocked',
    },
  });
  expect(scan.dispose).toHaveBeenCalledOnce();
});

it("reads the host's MCP tool enablement once per listing", async () => {
  const mcpTools = vi.fn(async () => new Map([['fixture.search', false]]));
  const { profile } = await listProfile(
    '---\ndescription: Searches\nmode: worker\ntools: fixture.search\n---\nBody.',
    reads({ mcpTools })
  );
  expect(mcpTools).toHaveBeenCalledOnce();
  expect(profile).toMatchObject({
    availability: {
      issues: [expect.objectContaining({ code: 'tool-disabled', toolId: 'fixture.search' })],
    },
  });
});

it('names a missing provider credential, read once for the listing', async () => {
  const readCredential = vi.fn(async () => undefined);
  const { profile } = await listProfile(
    '---\ndescription: Pinned\nmodel: anthropic::claude-fixture\n---\nBody.',
    reads({ readCredential })
  );
  expect(profile).toMatchObject({
    availability: {
      issues: expect.arrayContaining([expect.objectContaining({ code: 'credential-missing' })]),
      status: 'blocked',
    },
  });
  expect(readCredential).toHaveBeenCalledWith('anthropic');
});
