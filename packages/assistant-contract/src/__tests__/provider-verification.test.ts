import { describe, expect, it } from 'vitest';
import {
  PROVIDER_VERIFICATION_STATUSES,
  parseProviderVerificationSnapshot,
} from '../provider-verification.js';

const validResult = {
  checkedAt: '2026-08-18T12:00:00.000Z',
  status: 'verified',
} as const;

describe('parseProviderVerificationSnapshot', () => {
  it('accepts a live snapshot without detail', () => {
    expect(parseProviderVerificationSnapshot({ freshness: 'live', result: validResult })).toEqual({
      freshness: 'live',
      result: validResult,
    });
  });

  it('accepts a fresh-cache snapshot with a bounded detail', () => {
    const result = { ...validResult, detail: 'usage 1.2 of 10', status: 'verified_limited' };
    expect(parseProviderVerificationSnapshot({ freshness: 'fresh-cache', result })).toEqual({
      freshness: 'fresh-cache',
      result,
    });
  });

  it.each(PROVIDER_VERIFICATION_STATUSES)('accepts status %s', (status) => {
    expect(
      parseProviderVerificationSnapshot({ freshness: 'live', result: { ...validResult, status } })
    ).toMatchObject({ result: { status } });
  });

  it('rejects an unknown status', () => {
    expect(() =>
      parseProviderVerificationSnapshot({
        freshness: 'live',
        result: { ...validResult, status: 'maybe' },
      })
    ).toThrow('status');
  });

  it('rejects an invalid freshness', () => {
    expect(() =>
      parseProviderVerificationSnapshot({ freshness: 'stale-cache', result: validResult })
    ).toThrow('freshness');
  });

  it('rejects a missing or unparseable checkedAt', () => {
    expect(() =>
      parseProviderVerificationSnapshot({
        freshness: 'live',
        result: { status: 'verified' },
      })
    ).toThrow('checkedAt');
    expect(() =>
      parseProviderVerificationSnapshot({
        freshness: 'live',
        result: { checkedAt: 'not-a-date', status: 'verified' },
      })
    ).toThrow('checkedAt');
  });

  it('rejects an unbounded or blank detail', () => {
    expect(() =>
      parseProviderVerificationSnapshot({
        freshness: 'live',
        result: { ...validResult, detail: 'x'.repeat(301) },
      })
    ).toThrow('detail');
    expect(() =>
      parseProviderVerificationSnapshot({
        freshness: 'live',
        result: { ...validResult, detail: '   ' },
      })
    ).toThrow('detail');
  });

  it('rejects non-object payloads', () => {
    expect(() => parseProviderVerificationSnapshot('verified')).toThrow('object');
    expect(() => parseProviderVerificationSnapshot({ freshness: 'live', result: null })).toThrow(
      'object'
    );
  });
});
