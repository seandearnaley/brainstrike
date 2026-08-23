import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
  listAutoObservationalMemoryCandidates,
  OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET,
  resolveAutoObservationalMemoryModelTarget,
} from '../memory-settings.js';

describe('observational memory defaults (BST-940)', () => {
  it('enables observations by default at the Mastra-documented thresholds', () => {
    const om = DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory;
    expect(om.enabled).toBe(true);
    // Mastra docs: observation.messageTokens default 30,000; reflection.observationTokens default 40,000.
    expect(om.messageTokens).toBe(30_000);
    expect(om.observationTokens).toBe(40_000);
    expect(om.modelTarget).toBe(OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET);
  });

  it('pins the auto sentinel (a provider/model separator must never parse it)', () => {
    expect(OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET).toBe('auto');
    expect(OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET.includes('/')).toBe(false);
  });
});

describe('resolveAutoObservationalMemoryModelTarget (privacy: chat provider only)', () => {
  it.each([
    ['google', 'google/gemini-2.5-flash'],
    ['anthropic', 'anthropic/claude-haiku-4-5'],
    ['openai', 'openai/gpt-5.4-mini'],
    ['openrouter', 'openrouter/google/gemini-2.5-flash'],
  ])(
    'resolves a keyed %s chat to its own Mastra-tested fast observer',
    (chatProvider, expected) => {
      expect(
        resolveAutoObservationalMemoryModelTarget({
          chatProvider,
          providersWithKeys: ['google', 'anthropic', 'openai', 'openrouter'],
        })
      ).toBe(expected);
    }
  );

  it('never selects an observer from a provider other than the chat provider', () => {
    // Anthropic chat + only a Google key: resolving to Google would create new
    // data egress the user never opted into — must stay null.
    expect(
      resolveAutoObservationalMemoryModelTarget({
        chatProvider: 'anthropic',
        providersWithKeys: ['google'],
      })
    ).toBe(null);
  });

  it('returns null for local/runtime chat providers (no hosted egress for local chats)', () => {
    for (const chatProvider of ['local', 'ollama', 'lmstudio']) {
      expect(
        resolveAutoObservationalMemoryModelTarget({
          chatProvider,
          providersWithKeys: ['google', 'anthropic', 'openai', 'openrouter'],
        })
      ).toBe(null);
    }
  });

  it('returns null with no chat provider selected', () => {
    expect(
      resolveAutoObservationalMemoryModelTarget({
        chatProvider: null,
        providersWithKeys: ['google'],
      })
    ).toBe(null);
  });

  it('returns null when the chat provider has no key', () => {
    expect(
      resolveAutoObservationalMemoryModelTarget({ chatProvider: 'google', providersWithKeys: [] })
    ).toBe(null);
  });

  it('lists ordered OpenRouter fallbacks (preferred Gemini targets ship catalog-disabled)', () => {
    expect(
      listAutoObservationalMemoryCandidates({
        chatProvider: 'openrouter',
        providersWithKeys: ['openrouter'],
      })
    ).toEqual([
      'openrouter/google/gemini-2.5-flash',
      'openrouter/google/gemini-3.5-flash-lite',
      'openrouter/deepseek/deepseek-v4-flash',
    ]);
  });
});

describe('working-memory template (must never fall back to Mastra stock)', () => {
  it('names the sections a coding scratchpad needs', () => {
    // NOT a typeof/non-empty check: `as const` makes `template` a string
    // LITERAL type, so deleting the field is a compile error and no runtime
    // value can reach here that is empty or a non-string — such a test cannot
    // fail. The regression worth guarding is the template being GUTTED or
    // quietly re-shaped into something that no longer serves an IDE, which the
    // section names catch.
    //
    // (Absent means "somebody else's template", never "no template":
    // `@mastra/memory` substitutes its own personal-assistant profile.)
    const { template } = DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY;
    expect(template).toContain('# Session');
    expect(template).toContain('# Decisions');
    expect(template).toContain('# Open questions');
    expect(template).toContain('# Key paths');
  });

  it('carries no personal-profile fields', () => {
    // Verbatim field names from @mastra/memory's defaultWorkingMemoryTemplate.
    // A regression that drops our template would reintroduce every one of
    // these into the system prompt of every turn.
    const stockFields = [
      'First Name',
      'Last Name',
      'Location',
      'Occupation',
      'Interests',
      'Goals',
      'Events',
    ];
    const template = DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY.template;
    for (const field of stockFields) {
      expect(template).not.toContain(field);
    }
  });

  it('has no open-ended bucket for the model to fill with a transcript', () => {
    // A "Facts"/"Notes" section is unbounded by construction: Mastra's own tool
    // instruction says "If you're unsure whether to store something, store it".
    // Every section here names something small, current, and losable.
    const template = DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY.template;
    expect(template).not.toMatch(/^#+\s*(Facts|Notes|Misc|Other)\b/im);
  });

  it('is thread-scoped, so one thread cannot bill every other thread forever', () => {
    // 'resource' prepends this scratchpad to EVERY thread for the user, and
    // working memory has no decay — cross-thread continuity belongs to
    // observational memory and semantic recall, which retrieve on relevance.
    expect(DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY.scope).toBe('thread');
  });
});
