/**
 * Per-request persona resolution: built-in + user personas merged, renderer
 * availability preferences applied, and pinned-provider API keys resolved
 * server-side. The renderer field is UNTRUSTED preference data — malformed
 * shapes degrade to defaults with a warn, but a valid `delegationEnabled:
 * false` must reliably disable ALL delegation.
 */

import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract/personas';
import { describe, expect, it } from 'vitest';
import { resolveRequestPersonas } from '../../assistant-server/request-personas';

const noopLogger = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
} as never;

function userPersona(
  id: string,
  pin?: { modelId: string; provider: string }
): AssistantPersonaDefinition {
  return {
    allowedToolIds: ['brainstrike.readWorkspaceFile'],
    description: `user persona ${id}`,
    id,
    instructions: 'i',
    label: id,
    maxSteps: 4,
    source: 'user',
    ...(pin ? { model: pin } : {}),
  };
}

function params(overrides: Partial<Parameters<typeof resolveRequestPersonas>[0]> = {}) {
  return {
    logger: noopLogger,
    parentProvider: 'anthropic',
    request: undefined,
    resolveApiKey: () => Promise.resolve(undefined),
    scanUserPersonas: () => ({ entries: [], personas: [] }),
    ...overrides,
  };
}

describe('resolveRequestPersonas', () => {
  it('returns built-ins plus scanned user personas by default', async () => {
    const result = await resolveRequestPersonas(
      params({ scanUserPersonas: () => ({ entries: [], personas: [userPersona('sec')] }) })
    );
    expect(result.personas.map((persona) => persona.id)).toEqual([
      ...BUILT_IN_PERSONAS.map((persona) => persona.id),
      'sec',
    ]);
  });

  it('delegationEnabled=false disables every persona (and skips the scan)', async () => {
    let scanned = false;
    const result = await resolveRequestPersonas(
      params({
        request: { delegationEnabled: false },
        scanUserPersonas: () => {
          scanned = true;
          return { entries: [], personas: [] };
        },
      })
    );
    expect(result.personas).toEqual([]);
    expect(scanned).toBe(false);
  });

  it('filters disabled persona ids (built-in and user)', async () => {
    const result = await resolveRequestPersonas(
      params({
        request: { disabledPersonaIds: ['explore', 'sec'] },
        scanUserPersonas: () => ({
          entries: [],
          personas: [userPersona('sec'), userPersona('docs')],
        }),
      })
    );
    expect(result.personas.map((persona) => persona.id)).toEqual(['analyze', 'docs']);
  });

  it('resolves API keys for cross-provider pins only (parent + keyless skipped)', async () => {
    const asked: string[] = [];
    const result = await resolveRequestPersonas(
      params({
        resolveApiKey: (provider) => {
          asked.push(provider);
          return Promise.resolve(provider === 'openai' ? 'openai-key' : undefined);
        },
        scanUserPersonas: () => ({
          entries: [],
          personas: [
            userPersona('same', { modelId: 'claude-haiku-4-5', provider: 'anthropic' }),
            userPersona('cross', { modelId: 'gpt-5-mini', provider: 'openai' }),
            userPersona('ollama-pin', { modelId: 'llama3', provider: 'ollama' }),
          ],
        }),
      })
    );
    expect(asked).toEqual(['openai']);
    expect(result.personaProviderApiKeys).toEqual({ openai: 'openai-key' });
  });

  it('omits the key map entirely when no cross-provider pin resolves a key', async () => {
    const result = await resolveRequestPersonas(
      params({
        scanUserPersonas: () => ({
          entries: [],
          personas: [userPersona('cross', { modelId: 'm', provider: 'openai' })],
        }),
      })
    );
    expect(result.personaProviderApiKeys).toBeUndefined();
    // The persona stays in the list; the agent factory skips it with a warn
    // when the pin cannot resolve (single point of truth for that decision).
    expect(result.personas.some((persona) => persona.id === 'cross')).toBe(true);
  });

  it('a scan failure degrades to built-ins with a warn (chat must not break)', async () => {
    const result = await resolveRequestPersonas(
      params({
        scanUserPersonas: () => {
          throw new Error('disk exploded');
        },
      })
    );
    expect(result.personas.map((persona) => persona.id)).toEqual(
      BUILT_IN_PERSONAS.map((persona) => persona.id)
    );
  });

  it('ignores a malformed request shape (defaults, with every persona enabled)', async () => {
    const result = await resolveRequestPersonas(
      params({
        request: { disabledPersonaIds: 'explore' } as never,
      })
    );
    expect(result.personas.map((persona) => persona.id)).toEqual(
      BUILT_IN_PERSONAS.map((persona) => persona.id)
    );
  });
});
