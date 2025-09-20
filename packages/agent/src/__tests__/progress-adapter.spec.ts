import { describe, expect, it } from 'vitest';
import { normalizeProgressPayload } from '../tools/progress-adapter';

describe('normalizeProgressPayload', () => {
  it('handles step only', () => {
    expect(normalizeProgressPayload({ step: 'starting' })).toMatchObject({ step: 'starting' });
  });
  it('maps percent directly', () => {
    expect(normalizeProgressPayload({ percent: 42 })).toMatchObject({ percent: 42 });
  });
  it('converts progress 0..1 to percent', () => {
    expect(normalizeProgressPayload({ progress: 0.5 }).percent).toBe(50);
  });
  it('computes percent from done/total', () => {
    const res = normalizeProgressPayload({ done: 25, total: 100 });
    expect(res.percent).toBe(25);
    expect(res.note).toBe('25/100');
  });
  it('passes through unknown input safely', () => {
    expect(normalizeProgressPayload('x')).toEqual({ raw: 'x' });
  });
});
