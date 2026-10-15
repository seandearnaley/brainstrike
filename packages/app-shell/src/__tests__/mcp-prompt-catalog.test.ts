/**
 * BST-1592 — pure MCP prompt catalog projection: authority gating (connected +
 * advertised `prompts` feature), server-disambiguated ids/labels, stable
 * ordering, duplicate-name drop, and the liveness re-check the dialog uses when
 * a server disappears mid-selection.
 */
import type {
  ConfiguredMcpServerId,
  McpHostServerSnapshot,
  McpHostSnapshot,
} from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { isMcpPromptEntryLive, selectMcpPromptEntries } from '../mcp-prompts/mcp-prompt-catalog';

interface Prompt {
  arguments?: unknown;
  description?: string;
  name: string;
  title?: string;
}

function serverId(value: string): ConfiguredMcpServerId {
  return value as ConfiguredMcpServerId;
}

function connected(
  id: string,
  prompts: readonly Prompt[],
  features: { completion?: boolean; prompts?: boolean } = {},
  generation = 1
): McpHostServerSnapshot {
  return {
    catalog: {
      errors: {},
      features: {
        completion: features.completion ?? false,
        promptListChanged: false,
        prompts: features.prompts ?? true,
        resourceListChanged: false,
        resourceSubscriptions: false,
        resources: false,
        toolListChanged: false,
      },
      prompts: { prompts },
      subscription: { mode: 'none', state: 'closed' },
    },
    configuredProtocol: '2026-07-28',
    configuredServerId: serverId(id),
    generation,
    negotiated: { revision: '2026-07-28' },
    state: 'connected',
    transport: 'streamable-http',
  } as unknown as McpHostServerSnapshot;
}

function snapshot(servers: readonly McpHostServerSnapshot[]): McpHostSnapshot {
  return { revision: 1, servers };
}

describe('selectMcpPromptEntries', () => {
  it('offers prompts only from connected servers that advertise the feature', () => {
    const disconnected = {
      configuredProtocol: '2026-07-28',
      configuredServerId: serverId('offline'),
      generation: 3,
      state: 'disconnected',
      transport: 'stdio',
    } as unknown as McpHostServerSnapshot;
    const unsupported = connected('nofeature', [{ name: 'hidden' }], { prompts: false });
    const live = connected('alpha', [{ name: 'review' }]);

    const entries = selectMcpPromptEntries(snapshot([disconnected, unsupported, live]));

    expect(entries.map((entry) => entry.commandId)).toEqual(['mcp:alpha:review']);
  });

  it('disambiguates the same prompt name exposed by two servers', () => {
    const entries = selectMcpPromptEntries(
      snapshot([connected('beta', [{ name: 'review' }]), connected('alpha', [{ name: 'review' }])])
    );

    expect(entries.map((entry) => entry.commandId)).toEqual([
      'mcp:alpha:review',
      'mcp:beta:review',
    ]);
    expect(entries.map((entry) => entry.label)).toEqual(['review · alpha', 'review · beta']);
  });

  it('prefers the prompt title for display and sorts prompts by wire name', () => {
    const entries = selectMcpPromptEntries(
      snapshot([
        connected('alpha', [
          { description: 'Second', name: 'zeta', title: '  Z prompt  ' },
          { name: 'alpha_prompt' },
        ]),
      ])
    );

    expect(entries.map((entry) => entry.promptName)).toEqual(['alpha_prompt', 'zeta']);
    expect(entries[1]?.title).toBe('Z prompt');
    expect(entries[1]?.label).toBe('Z prompt · alpha');
    expect(entries[1]?.description).toBe('Second');
  });

  it('projects arguments with an explicit required flag', () => {
    const entries = selectMcpPromptEntries(
      snapshot([
        connected('alpha', [
          {
            arguments: [
              { description: 'Which file', name: 'path', required: true },
              { name: 'style' },
            ],
            name: 'review',
          },
        ]),
      ])
    );

    expect(entries[0]?.arguments).toEqual([
      { description: 'Which file', name: 'path', required: true },
      { name: 'style', required: false },
    ]);
  });

  it('reports completion support from the server catalog feature', () => {
    const [withCompletion] = selectMcpPromptEntries(
      snapshot([connected('alpha', [{ name: 'review' }], { completion: true })])
    );
    const [withoutCompletion] = selectMcpPromptEntries(
      snapshot([connected('beta', [{ name: 'review' }])])
    );

    expect(withCompletion?.completionSupported).toBe(true);
    expect(withoutCompletion?.completionSupported).toBe(false);
  });

  it('keeps the id injective when a server id or prompt name contains the delimiter', () => {
    // `ConfiguredMcpServerIdSchema` permits `:`, and a prompt name is whatever the
    // server published, so plain concatenation collided: server `a` + prompt
    // `b:c` and server `a:b` + prompt `c` both produced `mcp:a:b:c` and the
    // `seen` set dropped one VALID prompt.
    const entries = selectMcpPromptEntries(
      snapshot([connected('a', [{ name: 'b:c' }]), connected('a:b', [{ name: 'c' }])])
    );

    expect(entries.map((entry) => entry.commandId)).toEqual(['mcp:a:b\\:c', 'mcp:a\\:b:c']);
    expect(new Set(entries.map((entry) => entry.commandId)).size).toBe(2);
    // The LABEL keeps the raw values — escaping is an id concern only.
    expect(entries.map((entry) => entry.label)).toEqual(['b:c · a', 'c · a:b']);
  });

  it('leaves an ordinary id byte-identical (nothing to escape)', () => {
    const entries = selectMcpPromptEntries(snapshot([connected('alpha', [{ name: 'review' }])]));

    expect(entries[0]?.commandId).toBe('mcp:alpha:review');
  });

  it('drops a duplicate prompt name within one server rather than listing two identical rows', () => {
    const entries = selectMcpPromptEntries(
      snapshot([
        connected('alpha', [
          { name: 'review', title: 'First' },
          { name: 'review', title: 'Second' },
        ]),
      ])
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe('First');
  });
});

describe('isMcpPromptEntryLive', () => {
  const entry = selectMcpPromptEntries(snapshot([connected('alpha', [{ name: 'review' }])]))[0];

  it('requires an entry', () => {
    expect(entry).toBeDefined();
  });

  it('accepts the same server at the same generation', () => {
    expect(
      isMcpPromptEntryLive(
        entry as NonNullable<typeof entry>,
        snapshot([connected('alpha', [{ name: 'review' }])])
      )
    ).toBe(true);
  });

  it('rejects a retired generation, a disconnect, a removal, and a missing snapshot', () => {
    const live = entry as NonNullable<typeof entry>;
    expect(isMcpPromptEntryLive(live, null)).toBe(false);
    expect(isMcpPromptEntryLive(live, snapshot([]))).toBe(false);
    expect(
      isMcpPromptEntryLive(live, snapshot([connected('alpha', [{ name: 'review' }], {}, 2)]))
    ).toBe(false);
    expect(
      isMcpPromptEntryLive(
        live,
        snapshot([
          {
            configuredProtocol: '2026-07-28',
            configuredServerId: serverId('alpha'),
            generation: 1,
            state: 'disconnected',
            transport: 'streamable-http',
          } as unknown as McpHostServerSnapshot,
        ])
      )
    ).toBe(false);
  });
});
