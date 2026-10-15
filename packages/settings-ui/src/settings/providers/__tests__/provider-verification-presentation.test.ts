// @vitest-environment node
import { PROVIDER_VERIFICATION_STATUSES } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  formatCheckedAt,
  PROVIDER_VERIFICATION_PRESENTATION,
} from '../provider-verification-presentation';

describe('PROVIDER_VERIFICATION_PRESENTATION', () => {
  it('covers every contract status with a distinct label', () => {
    const labels = PROVIDER_VERIFICATION_STATUSES.map(
      (status) => PROVIDER_VERIFICATION_PRESENTATION[status].label
    );
    expect(labels).toHaveLength(PROVIDER_VERIFICATION_STATUSES.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('presents verified_limited as a success-with-caveat, never as a failure', () => {
    // BST-1357 contract: a 403-scoped bedrock key and a 429-quota OpenAI key
    // are VALID credentials. Rendering them as errors would send users to
    // re-enter a key that already works.
    const limited = PROVIDER_VERIFICATION_PRESENTATION.verified_limited;
    expect(limited.tone).toBe('warning');
    expect(limited.tone).not.toBe('danger');
    expect(limited.description.toLowerCase()).toContain('authenticated');
  });

  it('separates invalid (wrong key) from unreachable (no verdict) by tone and wording', () => {
    const invalid = PROVIDER_VERIFICATION_PRESENTATION.invalid;
    const unreachable = PROVIDER_VERIFICATION_PRESENTATION.unreachable;
    expect(invalid.tone).toBe('danger');
    expect(unreachable.tone).not.toBe('danger');
    expect(invalid.label).not.toBe(unreachable.label);
    expect(unreachable.description.toLowerCase()).toMatch(/network|reach|offline/);
  });

  it('marks verified as the only success tone', () => {
    const successes = PROVIDER_VERIFICATION_STATUSES.filter(
      (status) => PROVIDER_VERIFICATION_PRESENTATION[status].tone === 'success'
    );
    expect(successes).toEqual(['verified']);
  });

  it('presents not_applicable neutrally — there is nothing to test', () => {
    expect(PROVIDER_VERIFICATION_PRESENTATION.not_applicable.tone).toBe('neutral');
  });
});

describe('formatCheckedAt', () => {
  const now = new Date('2026-08-18T12:00:00.000Z');

  it('reads as "just now" inside a minute', () => {
    expect(formatCheckedAt('2026-08-18T11:59:30.000Z', now)).toBe('just now');
  });

  it('counts whole minutes and hours', () => {
    expect(formatCheckedAt('2026-08-18T11:55:00.000Z', now)).toBe('5 minutes ago');
    expect(formatCheckedAt('2026-08-18T11:59:00.000Z', now)).toBe('1 minute ago');
    expect(formatCheckedAt('2026-08-18T09:00:00.000Z', now)).toBe('3 hours ago');
  });

  it('falls back to a date beyond a day rather than counting ever upward', () => {
    expect(formatCheckedAt('2026-08-14T12:00:00.000Z', now)).toMatch(/2026/);
  });

  it('reports an unparseable timestamp instead of rendering "NaN ago"', () => {
    expect(formatCheckedAt('not-a-date', now)).toBe('unknown time');
  });
});
