import { describe, expect, it } from 'vitest';
import { calculateDynamicTotal, calculateProgressPercentage } from '../progress-utils';

describe('calculateDynamicTotal', () => {
  it('returns the current total when loaded does not exceed it', () => {
    expect(calculateDynamicTotal(1000, 500)).toBe(1000);
  });

  it('applies a minimum buffer of 500 when loaded surpasses the current total', () => {
    expect(calculateDynamicTotal(100, 200)).toBe(700);
  });

  it('applies a 25% buffer when larger than the minimum', () => {
    expect(calculateDynamicTotal(1000, 2000)).toBe(2500);
  });
});

describe('calculateProgressPercentage', () => {
  it('returns 0 when total is zero to avoid division errors', () => {
    expect(calculateProgressPercentage(10, 0)).toBe(0);
  });

  it('rounds the progress percentage to the nearest integer', () => {
    expect(calculateProgressPercentage(45, 90)).toBe(50);
  });
});
