import { describe, expect, it } from 'vitest';
import {
  isProviderCredential,
  MalformedCredentialError,
  type ProviderCredential,
  parseStoredCredential,
} from '../provider-credential';

/**
 * DECISION TABLE for parseStoredCredential (BST-1348) — settled, do not
 * relitigate:
 *
 * | stored raw value                                   | outcome                     |
 * | -------------------------------------------------- | --------------------------- |
 * | not JSON at all (`sk-abc123`)                      | legacy api_key of raw       |
 * | JSON but not an object (number/array/string/bool)  | legacy api_key of raw       |
 * | JSON object WITHOUT a `type` property              | legacy api_key of raw       |
 * | JSON object with `type` not in the union           | MalformedCredentialError    |
 * | JSON object with non-string `type`                 | MalformedCredentialError    |
 * | recognized `type`, missing/invalid required fields | MalformedCredentialError    |
 * | recognized `type`, invalid optional field types    | MalformedCredentialError    |
 * | recognized `type`, all fields valid                | that credential             |
 *
 * The `type` property is the tag marker: a value that never claims to be a
 * tagged credential is BY DEFINITION a legacy bare api_key (defined mapping,
 * not a fallback). A value that claims a tag but cannot be recognized or
 * validated is a hard failure — never coerced (NO SILENT FALLBACKS).
 */

describe('parseStoredCredential — legacy mapping (defined, not a fallback)', () => {
  it('maps a bare non-JSON string to an api_key credential of the raw string', () => {
    expect(parseStoredCredential('sk-abc123')).toEqual({ key: 'sk-abc123', type: 'api_key' });
  });

  it('maps a string that parses as a JSON number to an api_key of the RAW string', () => {
    expect(parseStoredCredential('12345')).toEqual({ key: '12345', type: 'api_key' });
  });

  it('maps a string that parses as a JSON array to an api_key of the RAW string', () => {
    expect(parseStoredCredential('["a","b"]')).toEqual({ key: '["a","b"]', type: 'api_key' });
  });

  it('maps a string that parses as a quoted JSON string to an api_key of the RAW string', () => {
    expect(parseStoredCredential('"quoted"')).toEqual({ key: '"quoted"', type: 'api_key' });
  });

  it('maps JSON booleans and null to an api_key of the RAW string', () => {
    expect(parseStoredCredential('true')).toEqual({ key: 'true', type: 'api_key' });
    expect(parseStoredCredential('null')).toEqual({ key: 'null', type: 'api_key' });
  });

  it('maps a JSON object WITHOUT a `type` property to an api_key of the RAW string', () => {
    expect(parseStoredCredential('{"key":"sk-x"}')).toEqual({
      key: '{"key":"sk-x"}',
      type: 'api_key',
    });
  });
});

describe('parseStoredCredential — round-trips for every credential type', () => {
  const roundTrip = (credential: ProviderCredential) =>
    parseStoredCredential(JSON.stringify(credential));

  it('round-trips an api_key credential without metadata', () => {
    const credential: ProviderCredential = { key: 'sk-abc', type: 'api_key' };
    expect(roundTrip(credential)).toEqual(credential);
  });

  it('round-trips an api_key credential with metadata', () => {
    const credential: ProviderCredential = {
      key: 'sk-abc',
      metadata: { org: 'org-1', project: 'proj-2' },
      type: 'api_key',
    };
    expect(roundTrip(credential)).toEqual(credential);
  });

  it('round-trips an oauth credential without accountId', () => {
    const credential: ProviderCredential = {
      access: 'at-1',
      expires: 1_755_500_000_000,
      refresh: 'rt-1',
      type: 'oauth',
    };
    expect(roundTrip(credential)).toEqual(credential);
  });

  it('round-trips an oauth credential with accountId', () => {
    const credential: ProviderCredential = {
      access: 'at-1',
      accountId: 'acct-9',
      expires: 1_755_500_000_000,
      refresh: 'rt-1',
      type: 'oauth',
    };
    expect(roundTrip(credential)).toEqual(credential);
  });

  it('round-trips an aws bearer credential', () => {
    const credential: ProviderCredential = {
      bearerKey: 'bedrock-bearer',
      mode: 'bearer',
      region: 'us-east-1',
      type: 'aws',
    };
    expect(roundTrip(credential)).toEqual(credential);
  });

  it('round-trips an aws profile_chain credential', () => {
    const credential: ProviderCredential = {
      mode: 'profile_chain',
      profile: 'work',
      region: 'eu-west-1',
      type: 'aws',
    };
    expect(roundTrip(credential)).toEqual(credential);
  });
});

describe('parseStoredCredential — hard failures (tagged but unrecognizable, never coerced)', () => {
  const expectMalformed = (raw: string) => {
    expect(() => parseStoredCredential(raw)).toThrow(MalformedCredentialError);
  };

  it('throws for a JSON object with an unrecognized `type`', () => {
    expectMalformed('{"type":"gcp","key":"x"}');
  });

  it('throws for a JSON object with a non-string `type`', () => {
    expectMalformed('{"type":42}');
    expectMalformed('{"type":null}');
  });

  it('throws for api_key with a missing or non-string key', () => {
    expectMalformed('{"type":"api_key"}');
    expectMalformed('{"type":"api_key","key":42}');
  });

  it('throws for api_key with non-string metadata values', () => {
    expectMalformed('{"type":"api_key","key":"sk","metadata":{"a":1}}');
    expectMalformed('{"type":"api_key","key":"sk","metadata":"nope"}');
  });

  it('throws for oauth missing required fields (the `{"type":"oauth"}` case)', () => {
    expectMalformed('{"type":"oauth"}');
    expectMalformed('{"type":"oauth","access":"a","refresh":"r"}');
    expectMalformed('{"type":"oauth","access":"a","expires":1}');
    expectMalformed('{"type":"oauth","refresh":"r","expires":1}');
  });

  it('throws for oauth with invalid field types', () => {
    expectMalformed('{"type":"oauth","access":"a","refresh":"r","expires":"soon"}');
    expectMalformed('{"type":"oauth","access":"a","refresh":"r","expires":1,"accountId":7}');
  });

  it('throws for oauth with a non-finite expires', () => {
    expectMalformed('{"type":"oauth","access":"a","refresh":"r","expires":null}');
  });

  it('throws for aws missing region or with an unrecognized mode', () => {
    expectMalformed('{"type":"aws","mode":"bearer","bearerKey":"k"}');
    expectMalformed('{"type":"aws","mode":"iam","region":"us-east-1"}');
    expectMalformed('{"type":"aws","region":"us-east-1"}');
  });

  it('throws for aws bearer mode WITHOUT a bearerKey (bearerKey is required for bearer)', () => {
    expectMalformed('{"type":"aws","mode":"bearer","region":"us-east-1"}');
  });

  it('throws for aws with invalid field types per mode', () => {
    expectMalformed('{"type":"aws","mode":"bearer","region":"us-east-1","bearerKey":1}');
    expectMalformed('{"type":"aws","mode":"profile_chain","region":"us-east-1","profile":[]}');
  });

  it('throws for api_key with an EMPTY key (an empty key is never a configured credential)', () => {
    expectMalformed('{"type":"api_key","key":""}');
  });

  it('never echoes the offending type tag or field values into the error message', () => {
    try {
      parseStoredCredential('{"type":"gcp","key":"super-secret-value"}');
      expect.unreachable('parseStoredCredential must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedCredentialError);
      const message = (error as MalformedCredentialError).message;
      expect(message).not.toContain('gcp');
      expect(message).not.toContain('super-secret-value');
    }
  });
});

describe('isProviderCredential', () => {
  it('accepts every valid credential variant', () => {
    expect(isProviderCredential({ key: 'sk', type: 'api_key' })).toBe(true);
    expect(isProviderCredential({ access: 'a', expires: 1, refresh: 'r', type: 'oauth' })).toBe(
      true
    );
    expect(
      isProviderCredential({ bearerKey: 'k', mode: 'bearer', region: 'us-east-1', type: 'aws' })
    ).toBe(true);
    expect(isProviderCredential({ mode: 'profile_chain', region: 'us-east-1', type: 'aws' })).toBe(
      true
    );
  });

  it('rejects an aws bearer credential without bearerKey and an api_key with an empty key', () => {
    expect(isProviderCredential({ mode: 'bearer', region: 'us-east-1', type: 'aws' })).toBe(false);
    expect(isProviderCredential({ key: '', type: 'api_key' })).toBe(false);
  });

  it('rejects non-objects, unrecognized tags, and invalid fields', () => {
    expect(isProviderCredential('sk-abc')).toBe(false);
    expect(isProviderCredential(null)).toBe(false);
    expect(isProviderCredential({ key: 'sk' })).toBe(false);
    expect(isProviderCredential({ key: 'sk', type: 'gcp' })).toBe(false);
    expect(isProviderCredential({ type: 'oauth' })).toBe(false);
    expect(isProviderCredential({ mode: 'iam', region: 'us-east-1', type: 'aws' })).toBe(false);
  });
});
