import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  decodeProviderArgs,
  decodeProviderCredentialArgs,
  decodeProviderValueArgs,
} from '../../ipc-secrets-args';

const SECRET = 'sk-never-echo-4242';

function thrownBy(decode: () => unknown): unknown {
  try {
    decode();
  } catch (error: unknown) {
    return error;
  }
  return null;
}

describe('secrets IPC argument decoders', () => {
  it('accepts well-formed argument lists', () => {
    expect(decodeProviderArgs(['openai'])).toEqual(['openai']);
    expect(decodeProviderValueArgs(['openai', SECRET])).toEqual(['openai', SECRET]);
    const credential = { key: SECRET, type: 'api_key' };
    expect(decodeProviderCredentialArgs(['openai', credential])).toEqual(['openai', credential]);
  });

  it.each([
    ['a C0 control character', 'openai\u0000'],
    ['DEL', 'openai\u007f'],
    ['a C1 control character', 'openai\u0085'],
    ['an empty id', ''],
    ['an over-long id', 'x'.repeat(257)],
  ])('rejects a provider id with %s', (_label, provider) => {
    expect(() => decodeProviderArgs([provider])).toThrow(
      /^secrets IPC provider must be a non-empty string/u
    );
  });

  // Effect's default issue formatting could start quoting inputs on an upgrade;
  // a rejected `secrets:*` call must never carry the secret into a log.
  it.each([
    ['an extra argument', () => decodeProviderValueArgs(['openai', SECRET, 'extra'])],
    ['an invalid provider beside the secret', () => decodeProviderValueArgs(['', SECRET])],
    ['the secret as a provider id', () => decodeProviderValueArgs([`${SECRET}\u0085`, 'value'])],
    ['a non-string secret', () => decodeProviderValueArgs(['openai', { key: SECRET }])],
    [
      'an extra credential argument',
      () => decodeProviderCredentialArgs(['openai', { key: SECRET }, SECRET]),
    ],
  ])('never echoes the secret when rejecting %s', (_label, decode) => {
    const error = thrownBy(decode);

    expect(error).toBeInstanceOf(TypeError);
    // The whole error, cause included, as a main-process log would print it.
    expect(inspect(error, { depth: null })).not.toContain(SECRET);
  });
});
