/**
 * Persona discovery IPC: built-ins + user personas (valid AND invalid) in one
 * list for the settings panel. Mirrors ipc-user-commands-handlers coverage.
 */

import { BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { inspectPersonaAvailability } from '../../assistant-server/persona-availability';
import { __resetUserPersonaWarningsForTests } from '../../assistant-server/user-personas-loader';
import { listUserPersonas } from '../../ipc-user-personas-handlers';

const HOME = '/home/user';

function makeFs(dirs: Record<string, Record<string, string>>) {
  return {
    listDir: (absDir: string) => {
      const files = dirs[absDir];
      if (!files) {
        return null;
      }
      return {
        entries: Object.keys(files).map((name) => ({
          isDirectory: false,
          isFile: true,
          name,
        })),
        inspected: Object.keys(files).length,
        truncated: false,
      };
    },
    readFile: (absFile: string) => {
      for (const [dir, files] of Object.entries(dirs)) {
        for (const [name, content] of Object.entries(files)) {
          if (`${dir}/${name}` === absFile) {
            return { content, ok: true } as const;
          }
        }
      }
      return { ok: false, reason: 'unreadable' } as const;
    },
  };
}

beforeEach(() => {
  __resetUserPersonaWarningsForTests();
});

describe('listUserPersonas', () => {
  it('rejects an unavailable authoritative root catalog rather than returning built-ins', async () => {
    const failure = new Error('Catalog unavailable');
    await expect(
      listUserPersonas({
        fs: makeFs({}),
        homedir: () => HOME,
        workspaceRoots: {
          workspaceRoots: async () => {
            throw failure;
          },
        },
      })
    ).rejects.toBe(failure);
  });

  it('lists built-ins first, then user personas with source metadata', async () => {
    const result = await listUserPersonas({
      fs: makeFs({
        [`${HOME}/.brainstrike/agents`]: {
          'sec.md': '---\ndescription: security\nmodel: anthropic::claude-haiku-4-5\n---\nBody.',
        },
      }),
      homedir: () => HOME,
      workspaceRoots: { workspaceRoots: async () => ({ roots: [] }) },
    });

    const builtInRows = result.personas.slice(0, BUILT_IN_PERSONAS.length);
    expect(builtInRows.map((row) => row.id)).toEqual(BUILT_IN_PERSONAS.map((p) => p.id));
    expect(builtInRows.every((row) => row.source === 'built-in' && row.status === 'ok')).toBe(true);

    const userRow = result.personas.at(-1);
    expect(userRow).toMatchObject({
      id: 'sec',
      modelPin: 'anthropic::claude-haiku-4-5',
      source: 'user',
      status: 'ok',
    });
    expect(userRow?.absPath).toBe(`${HOME}/.brainstrike/agents/sec.md`);
  });

  it("carries each loadable persona's mode, step budget and tool scope so Settings states what the host enforces", async () => {
    const result = await listUserPersonas({
      fs: makeFs({
        [`${HOME}/.brainstrike/agents`]: {
          'shipper.md': '---\ndescription: ships\nmode: worker\nmaxSteps: 12\n---\nBody.',
          'surveyor.md':
            '---\ndescription: surveys\ntools:\n  - readWorkspaceFile\n  - grepSearch\n---\nBody.',
        },
      }),
      homedir: () => HOME,
      workspaceRoots: { workspaceRoots: async () => ({ roots: [] }) },
    });
    const byId = new Map(result.personas.map((row) => [row.id, row]));
    const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
    expect(byId.get('worker')).toMatchObject({
      allowedToolIds: ['*'],
      maxSteps: worker?.maxSteps,
      mode: 'worker',
    });
    const explore = BUILT_IN_PERSONAS.find((persona) => persona.id === 'explore');
    expect(byId.get('explore')).toMatchObject({
      allowedToolIds: explore?.allowedToolIds,
      maxSteps: explore?.maxSteps,
      mode: 'read-only',
    });
    expect(byId.get('shipper')).toMatchObject({
      allowedToolIds: ['*'],
      maxSteps: 12,
      mode: 'worker',
      status: 'ok',
    });
    expect(byId.get('surveyor')).toMatchObject({
      allowedToolIds: ['brainstrike.readWorkspaceFile', 'brainstrike.grepSearch'],
      mode: 'read-only',
      status: 'ok',
    });
  });

  it('includes invalid user persona files with their error', async () => {
    const result = await listUserPersonas({
      fs: makeFs({
        [`${HOME}/.brainstrike/agents`]: {
          'bad.md': '---\ndescription: d\ntools: writeWorkspaceFile\n---\nBody.',
        },
      }),
      homedir: () => HOME,
      workspaceRoots: { workspaceRoots: async () => ({ roots: [] }) },
    });
    const invalid = result.personas.find((row) => row.status === 'invalid');
    expect(invalid).toBeDefined();
    expect(invalid?.error).toMatch(/read/i);
    expect(invalid?.source).toBe('user');
  });

  it('includes SHADOWED files as their own row, not as an error', async () => {
    // `reviewer.markdown` and `reviewer.md` both derive the id `reviewer`, so
    // one suppresses the other inside a single directory — no multi-root
    // setup needed. The loser must appear (BST-936), and must NOT be reported
    // as invalid: it is a precedence outcome, not an authoring mistake.
    const result = await listUserPersonas({
      fs: makeFs({
        [`${HOME}/.brainstrike/agents`]: {
          'reviewer.markdown': '---\ndescription: first\n---\nBody.',
          'reviewer.md': '---\ndescription: second\n---\nBody.',
        },
      }),
      homedir: () => HOME,
      workspaceRoots: { workspaceRoots: async () => ({ roots: [] }) },
    });

    expect(
      result.personas.filter((row) => row.status === 'ok' && row.source === 'user')
    ).toHaveLength(1);
    const shadowed = result.personas.find((row) => row.status === 'shadowed');
    expect(shadowed).toMatchObject({
      id: 'reviewer.md',
      shadowedBy: { absPath: `${HOME}/.brainstrike/agents/reviewer.markdown` },
      source: 'user',
    });
    expect(shadowed?.error).toBeUndefined();
    expect(result.personas.some((row) => row.status === 'invalid')).toBe(false);
  });

  it('reports a truncated persona directory listing', async () => {
    const result = await listUserPersonas({
      fs: {
        listDir: () => ({
          entries: [{ isDirectory: false, isFile: true, name: 'ok.md' }],
          inspected: 1,
          truncated: true,
        }),
        readFile: () => ({ content: '---\ndescription: d\n---\nBody.', ok: true }) as const,
      },
      homedir: () => HOME,
      workspaceRoots: { workspaceRoots: async () => ({ roots: [] }) },
    });

    expect(result.incompleteDirs).toEqual([
      { dir: `${HOME}/.brainstrike/agents`, reason: 'listing-truncated' },
    ]);
  });

  it('returns only built-ins when no persona dirs exist', async () => {
    const result = await listUserPersonas({
      fs: makeFs({}),
      homedir: () => HOME,
      workspaceRoots: { workspaceRoots: async () => ({ roots: [] }) },
    });
    expect(result.personas).toHaveLength(BUILT_IN_PERSONAS.length);
  });
});

describe('host availability through the Settings list entry point', () => {
  it('surfaces missing credentials, missing tools and unknown model pins without changing profile identity', async () => {
    const result = await listUserPersonas({
      fs: makeFs({
        [`${HOME}/.brainstrike/agents`]: {
          'shipper.md':
            '---\ndescription: ships\nmode: worker\nmodel: anthropic::missing-model\ntools: missing.edit, readWorkspaceFile\n---\nBody.',
        },
      }),
      homedir: () => HOME,
      inspectAvailability: (persona) =>
        inspectPersonaAvailability(persona, {
          mcpTools: new Map(),
          models: [],
          readCredential: async () => undefined,
        }),
      workspaceRoots: { workspaceRoots: async () => ({ roots: [] }) },
    });
    const row = result.personas.find((item) => item.id === 'shipper');
    expect(row).toMatchObject({
      availability: {
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'credential-missing' }),
          expect.objectContaining({ code: 'model-not-listed' }),
          expect.objectContaining({ code: 'tool-not-discovered', toolId: 'missing.edit' }),
        ]),
        status: 'blocked',
      },
      id: 'shipper',
      modelPin: 'anthropic::missing-model',
      status: 'ok',
    });
    expect(row?.allowedToolIds).toEqual(['missing.edit', 'brainstrike.readWorkspaceFile']);
  });

  it('checks built-ins through the list while rejecting reserved ids and unknown providers before availability', async () => {
    const result = await listUserPersonas({
      fs: makeFs({
        [`${HOME}/.brainstrike/agents`]: {
          'unknown.md': '---\ndescription: Unknown provider\nmodel: flooby::missing\n---\nBody.',
          'worker.md': '---\ndescription: Forged worker\nmodel: anthropic::missing\n---\nBody.',
        },
      }),
      homedir: () => HOME,
      inspectAvailability: (persona) =>
        inspectPersonaAvailability(persona, {
          mcpTools: new Map(),
          models: [],
          readCredential: async () => undefined,
        }),
      workspaceRoots: { workspaceRoots: async () => ({ roots: [] }) },
    });
    expect(result.personas.find((item) => item.id === 'worker')).toMatchObject({
      availability: { issues: [], status: 'request-dependent' },
      source: 'built-in',
      status: 'ok',
    });
    const invalid = result.personas.filter((item) => item.source === 'user');
    expect(invalid).toHaveLength(2);
    expect(invalid.every((item) => item.status === 'invalid' && !item.availability)).toBe(true);
    expect(JSON.stringify(invalid)).toContain('collides with a built-in persona');
    expect(JSON.stringify(invalid)).toContain('unknown model pin provider');
  });

  // The rule is DERIVED from `capabilities.llm`, not from the provider's name:
  // the built-in on-device provider is embeddings-only, so a pin to it cannot
  // run an assistant at all — worker mode or otherwise.
  it('blocks a pin to an embeddings-only provider by the same capability rule as runtime', async () => {
    const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
    if (!worker) {
      throw new Error('Missing worker');
    }
    const result = await inspectPersonaAvailability(
      { ...worker, model: { modelId: 'local-model', provider: 'local' } },
      {
        mcpTools: new Map(),
        models: [{ id: 'local-model', providerId: 'local', type: 'llm' }],
        readCredential: async () => {
          throw new Error('Keyless provider must not read credentials');
        },
      }
    );
    expect(result.status).toBe('blocked');
    expect(result.issues.map((issue) => issue.code)).toContain('model-unsupported');
  });

  it('distinguishes disabled and missing tools without treating declared tools as effective access', async () => {
    const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
    if (!worker) {
      throw new Error('Missing worker');
    }
    const result = await inspectPersonaAvailability(
      { ...worker, allowedToolIds: ['server.enabled', 'server.disabled', 'server.missing'] },
      {
        mcpTools: new Map([
          ['server.enabled', true],
          ['server.disabled', false],
        ]),
        models: [],
        readCredential: async () => undefined,
      }
    );
    expect(result).toEqual({
      issues: [
        expect.objectContaining({ code: 'tool-disabled', toolId: 'server.disabled' }),
        expect.objectContaining({ code: 'tool-not-discovered', toolId: 'server.missing' }),
      ],
      status: 'needs-attention',
    });
  });

  it('does not expose credential errors or claim an unlisted model is definitively invalid', async () => {
    const builtin = BUILT_IN_PERSONAS[0];
    if (!builtin) {
      throw new Error('Missing built-in');
    }
    const persona = { ...builtin, model: { modelId: 'custom-id', provider: 'openai' } };
    const inputs = {
      mcpTools: new Map<string, boolean>(),
      models: [],
      readCredential: async () => ({ key: 'secret', type: 'api_key' as const }),
    };
    expect(await inspectPersonaAvailability(persona, inputs)).toMatchObject({
      issues: [{ code: 'model-not-listed' }],
      status: 'needs-attention',
    });
    const unavailable = await inspectPersonaAvailability(persona, {
      ...inputs,
      readCredential: async () => {
        throw new Error('secret key path');
      },
    });
    expect(unavailable).toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'credential-unreadable' })]),
      status: 'blocked',
    });
    expect(JSON.stringify(unavailable)).not.toContain('secret');
  });

  it.each([
    { modelId: 'embed-english-v3.0', provider: 'cohere' },
    { modelId: 'text-embedding-3-small', provider: 'openai' },
  ])(
    'rejects a catalogued embedding-only persona model through the list ($provider)',
    async ({ provider, modelId }) => {
      const result = await listUserPersonas({
        fs: makeFs({
          [`${HOME}/.brainstrike/agents`]: {
            'embedding.md': `---\ndescription: Invalid agent model\nmodel: ${provider}::${modelId}\n---\nBody.`,
          },
        }),
        homedir: () => HOME,
        inspectAvailability: (persona) =>
          inspectPersonaAvailability(persona, {
            mcpTools: new Map(),
            models: [{ id: modelId, providerId: provider, type: 'embedding' }],
            readCredential: async () => ({ key: 'configured', type: 'api_key' }),
          }),
        workspaceRoots: { workspaceRoots: async () => ({ roots: [] }) },
      });
      expect(result.personas.find((item) => item.id === 'embedding')).toMatchObject({
        availability: {
          issues: [expect.objectContaining({ code: 'model-unsupported' })],
          status: 'blocked',
        },
      });
    }
  );
});
