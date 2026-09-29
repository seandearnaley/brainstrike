import { describe, expect, it } from 'vitest';
import {
  createStoredKeyFingerprint,
  isStoredKeyFingerprint,
  parseProviderKeySources,
} from '../provider-key-source.js';

const invalidPayload = () => new Error('invalid provider key payload');

const parseOptions = {
  allowedProviders: new Set(['openai', 'tavily']),
  invalidPayload,
  isAllowedEnvVar: (provider: string, envVar: string) =>
    provider === 'tavily' ? envVar === 'TAVILY_API_KEY' : envVar === 'OPENAI_API_KEY',
};

describe('createStoredKeyFingerprint', () => {
  it('captures only the last four characters and an ISO timestamp', () => {
    const fingerprint = createStoredKeyFingerprint(
      'sk-ant-test-123',
      new Date('2026-08-18T10:00:00.000Z')
    );

    expect(fingerprint).toEqual({ last4: '-123', savedAt: '2026-08-18T10:00:00.000Z' });
  });

  it('never captures more than four characters', () => {
    const fingerprint = createStoredKeyFingerprint(
      'abcdefgh',
      new Date('2026-08-18T10:00:00.000Z')
    );

    expect(fingerprint?.last4).toBe('efgh');
    expect(fingerprint?.last4).toHaveLength(4);
  });

  it('yields NO fingerprint for secrets shorter than eight characters', () => {
    // …last4 of a 7-character secret would reveal over half the key material,
    // so short secrets get no fingerprint at all (Stored badge, no hint).
    expect(createStoredKeyFingerprint('abcdefg', new Date())).toBeUndefined();
    expect(createStoredKeyFingerprint('a', new Date())).toBeUndefined();
    // Whitespace padding does not count toward the floor.
    expect(createStoredKeyFingerprint('  abcdefg  ', new Date())).toBeUndefined();
    // Exactly eight characters is the smallest fingerprintable secret.
    expect(createStoredKeyFingerprint('abcdefgh', new Date())).toBeDefined();
  });

  it('rejects an empty or whitespace-only secret instead of fabricating a fingerprint', () => {
    expect(() => createStoredKeyFingerprint('', new Date())).toThrow(/empty/i);
    expect(() => createStoredKeyFingerprint('   ', new Date())).toThrow(/empty/i);
  });

  it('defaults savedAt to now', () => {
    const before = Date.now();
    const fingerprint = createStoredKeyFingerprint('sk-live-abcd');
    const after = Date.now();

    const parsed = Date.parse(fingerprint?.savedAt ?? '');
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});

describe('isStoredKeyFingerprint', () => {
  it('accepts the exact {last4, savedAt} shape', () => {
    expect(isStoredKeyFingerprint({ last4: 'abcd', savedAt: '2026-08-18T10:00:00.000Z' })).toBe(
      true
    );
  });

  it('accepts a short last4 (secrets shorter than four characters)', () => {
    expect(isStoredKeyFingerprint({ last4: 'ab', savedAt: '2026-08-18T10:00:00.000Z' })).toBe(true);
  });

  it('rejects non-objects, missing keys, and extra keys', () => {
    expect(isStoredKeyFingerprint(null)).toBe(false);
    expect(isStoredKeyFingerprint('abcd')).toBe(false);
    expect(isStoredKeyFingerprint({ last4: 'abcd' })).toBe(false);
    expect(isStoredKeyFingerprint({ savedAt: '2026-08-18T10:00:00.000Z' })).toBe(false);
    expect(
      isStoredKeyFingerprint({ extra: 1, last4: 'abcd', savedAt: '2026-08-18T10:00:00.000Z' })
    ).toBe(false);
  });

  it('rejects a last4 longer than four characters — that would leak key material', () => {
    expect(isStoredKeyFingerprint({ last4: 'abcde', savedAt: '2026-08-18T10:00:00.000Z' })).toBe(
      false
    );
  });

  it('rejects an empty last4 and a non-parseable savedAt', () => {
    expect(isStoredKeyFingerprint({ last4: '', savedAt: '2026-08-18T10:00:00.000Z' })).toBe(false);
    expect(isStoredKeyFingerprint({ last4: 'abcd', savedAt: 'not-a-date' })).toBe(false);
    expect(isStoredKeyFingerprint({ last4: 'abcd', savedAt: 42 })).toBe(false);
  });
});

describe('parseProviderKeySources', () => {
  it('parses stored and env entries', () => {
    const sources = parseProviderKeySources(
      [
        { provider: 'openai', source: 'stored' },
        { envVar: 'TAVILY_API_KEY', provider: 'tavily', source: 'env' },
      ],
      parseOptions
    );

    expect(sources).toEqual([
      { provider: 'openai', source: 'stored' },
      { envVar: 'TAVILY_API_KEY', provider: 'tavily', source: 'env' },
    ]);
  });

  // BST-1353: `authMode` names which AWS auth form won resolution. It is
  // optional (absent on every non-aws provider) but validated hard — and the
  // parser stayed STRICT: unrecognized keys still reject the whole payload.
  it('parses an optional authMode on stored AND env entries', () => {
    const sources = parseProviderKeySources(
      [
        { authMode: 'profile_chain', provider: 'openai', source: 'stored' },
        { authMode: 'bearer', envVar: 'TAVILY_API_KEY', provider: 'tavily', source: 'env' },
      ],
      parseOptions
    );

    expect(sources).toEqual([
      { authMode: 'profile_chain', provider: 'openai', source: 'stored' },
      { authMode: 'bearer', envVar: 'TAVILY_API_KEY', provider: 'tavily', source: 'env' },
    ]);
  });

  it('parses authMode ALONGSIDE fingerprint metadata', () => {
    expect(
      parseProviderKeySources(
        [
          {
            authMode: 'bearer',
            metadata: { last4: '-123', savedAt: '2026-08-18T10:00:00.000Z' },
            provider: 'openai',
            source: 'stored',
          },
        ],
        parseOptions
      )
    ).toEqual([
      {
        authMode: 'bearer',
        metadata: { last4: '-123', savedAt: '2026-08-18T10:00:00.000Z' },
        provider: 'openai',
        source: 'stored',
      },
    ]);
  });

  it('rejects an UNKNOWN authMode rather than dropping it', () => {
    expect(() =>
      parseProviderKeySources(
        [{ authMode: 'sigv4', provider: 'openai', source: 'stored' }],
        parseOptions
      )
    ).toThrow();
    expect(() =>
      parseProviderKeySources(
        [{ authMode: 'bearer', envVar: 'TAVILY_API_KEY', provider: 'tavily', source: 'env' }],
        parseOptions
      )
    ).not.toThrow();
  });

  it('still rejects an unrecognized key on either arm (strictness preserved)', () => {
    expect(() =>
      parseProviderKeySources(
        [{ provider: 'openai', source: 'stored', unexpected: 'x' }],
        parseOptions
      )
    ).toThrow();
    expect(() =>
      parseProviderKeySources(
        [{ envVar: 'TAVILY_API_KEY', provider: 'tavily', source: 'env', unexpected: 'x' }],
        parseOptions
      )
    ).toThrow();
  });

  it('parses a stored entry with a valid fingerprint metadata', () => {
    const sources = parseProviderKeySources(
      [
        {
          metadata: { last4: '-123', savedAt: '2026-08-18T10:00:00.000Z' },
          provider: 'openai',
          source: 'stored',
        },
      ],
      parseOptions
    );

    expect(sources).toEqual([
      {
        metadata: { last4: '-123', savedAt: '2026-08-18T10:00:00.000Z' },
        provider: 'openai',
        source: 'stored',
      },
    ]);
  });

  it('throws the consumer error for malformed metadata instead of guessing', () => {
    expect(() =>
      parseProviderKeySources(
        [
          {
            metadata: { last4: 'toolong5', savedAt: '2026-08-18T10:00:00.000Z' },
            provider: 'openai',
            source: 'stored',
          },
        ],
        parseOptions
      )
    ).toThrow('invalid provider key payload');
    expect(() =>
      parseProviderKeySources(
        [
          {
            metadata: { last4: '-123', savedAt: 'garbage' },
            provider: 'openai',
            source: 'stored',
          },
        ],
        parseOptions
      )
    ).toThrow('invalid provider key payload');
    expect(() =>
      parseProviderKeySources(
        [{ metadata: 'oops', provider: 'openai', source: 'stored' }],
        parseOptions
      )
    ).toThrow('invalid provider key payload');
  });

  it('rejects non-arrays, unknown providers, duplicates, and unknown sources', () => {
    expect(() => parseProviderKeySources('nope', parseOptions)).toThrow(
      'invalid provider key payload'
    );
    expect(() =>
      parseProviderKeySources([{ provider: 'nonsense', source: 'stored' }], parseOptions)
    ).toThrow('invalid provider key payload');
    expect(() =>
      parseProviderKeySources(
        [
          { provider: 'openai', source: 'stored' },
          { provider: 'openai', source: 'stored' },
        ],
        parseOptions
      )
    ).toThrow('invalid provider key payload');
    expect(() =>
      parseProviderKeySources([{ provider: 'openai', source: 'weird' }], parseOptions)
    ).toThrow('invalid provider key payload');
  });

  it('rejects stored entries with an envVar or other unexpected keys', () => {
    expect(() =>
      parseProviderKeySources(
        [{ envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'stored' }],
        parseOptions
      )
    ).toThrow('invalid provider key payload');
    expect(() =>
      parseProviderKeySources([{ extra: true, provider: 'openai', source: 'stored' }], parseOptions)
    ).toThrow('invalid provider key payload');
  });

  it('rejects env entries with a missing, empty, foreign, or extra-keyed envVar', () => {
    expect(() =>
      parseProviderKeySources([{ provider: 'openai', source: 'env' }], parseOptions)
    ).toThrow('invalid provider key payload');
    expect(() =>
      parseProviderKeySources([{ envVar: '   ', provider: 'openai', source: 'env' }], parseOptions)
    ).toThrow('invalid provider key payload');
    expect(() =>
      parseProviderKeySources(
        [{ envVar: 'TAVILY_API_KEY', provider: 'openai', source: 'env' }],
        parseOptions
      )
    ).toThrow('invalid provider key payload');
    expect(() =>
      parseProviderKeySources(
        [{ envVar: 'OPENAI_API_KEY', extra: 1, provider: 'openai', source: 'env' }],
        parseOptions
      )
    ).toThrow('invalid provider key payload');
    expect(() =>
      parseProviderKeySources(
        [
          {
            envVar: 'OPENAI_API_KEY',
            metadata: { last4: 'abcd', savedAt: '2026-08-18T10:00:00.000Z' },
            provider: 'openai',
            source: 'env',
          },
        ],
        parseOptions
      )
    ).toThrow('invalid provider key payload');
  });
});
