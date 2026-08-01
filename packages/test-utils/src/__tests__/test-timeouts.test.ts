import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAdjustedTimeout,
  getTestTimeout,
  getTimeoutMultiplier,
  TEST_TIMEOUTS,
} from '../test-timeouts';

describe('test timeouts', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars
    Reflect.deleteProperty(process.env, 'CI');
    Reflect.deleteProperty(process.env, 'DEBUG');
    Reflect.deleteProperty(process.env, 'TEST_TIMEOUT_MULTIPLIER');
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe('TEST_TIMEOUTS', () => {
    it('should have predefined timeout values', () => {
      expect(TEST_TIMEOUTS.unit).toBe(10_000);
      expect(TEST_TIMEOUTS.integration).toBe(15_000);
      expect(TEST_TIMEOUTS.database).toBe(20_000);
      expect(TEST_TIMEOUTS.uiComponent).toBe(15_000);
      expect(TEST_TIMEOUTS.e2e).toBe(60_000);
      expect(TEST_TIMEOUTS.performance).toBe(120_000);
      expect(TEST_TIMEOUTS.heavy).toBe(30_000);
    });
  });

  describe('getTestTimeout', () => {
    it('should return the correct timeout for unit tests', () => {
      expect(getTestTimeout('unit')).toBe(10_000);
    });

    it('should return the correct timeout for integration tests', () => {
      expect(getTestTimeout('integration')).toBe(15_000);
    });

    it('should return the correct timeout for database tests', () => {
      expect(getTestTimeout('database')).toBe(20_000);
    });

    it('should return the correct timeout for UI component tests', () => {
      expect(getTestTimeout('uiComponent')).toBe(15_000);
    });

    it('should return the correct timeout for e2e tests', () => {
      expect(getTestTimeout('e2e')).toBe(60_000);
    });

    it('should return the correct timeout for performance tests', () => {
      expect(getTestTimeout('performance')).toBe(120_000);
    });

    it('should return the correct timeout for heavy tests', () => {
      expect(getTestTimeout('heavy')).toBe(30_000);
    });
  });

  describe('getTimeoutMultiplier', () => {
    it('should return 1 by default', () => {
      expect(getTimeoutMultiplier()).toBe(1);
    });

    it('should return 2 in CI environment', () => {
      process.env['CI'] = 'true';
      expect(getTimeoutMultiplier()).toBe(2);
    });

    it('should return 5 in DEBUG environment', () => {
      process.env['DEBUG'] = 'true';
      expect(getTimeoutMultiplier()).toBe(5);
    });

    it('should use an explicit timeout multiplier without enabling CI behavior', () => {
      process.env['TEST_TIMEOUT_MULTIPLIER'] = '1.5';
      expect(getTimeoutMultiplier()).toBe(1.5);
    });

    it('should prioritize the explicit multiplier over CI and DEBUG defaults', () => {
      process.env['CI'] = 'true';
      process.env['DEBUG'] = 'true';
      process.env['TEST_TIMEOUT_MULTIPLIER'] = '3';
      expect(getTimeoutMultiplier()).toBe(3);
    });

    it.each([
      '',
      '0',
      '-1',
      ' 2',
      '2 ',
      '01',
      '1e2',
      'Infinity',
      'NaN',
      'two',
    ])('should fail loudly for malformed explicit multiplier %j', (configuredMultiplier) => {
      process.env['TEST_TIMEOUT_MULTIPLIER'] = configuredMultiplier;
      expect(() => getTimeoutMultiplier()).toThrowError(
        `Invalid TEST_TIMEOUT_MULTIPLIER ${JSON.stringify(configuredMultiplier)}; expected a positive decimal number.`
      );
    });

    it('should prioritize CI over DEBUG', () => {
      process.env['CI'] = 'true';
      process.env['DEBUG'] = 'true';
      expect(getTimeoutMultiplier()).toBe(2);
    });

    it('should work with CI set to any truthy value', () => {
      process.env['CI'] = '1';
      expect(getTimeoutMultiplier()).toBe(2);
    });

    it('should work with DEBUG set to any truthy value', () => {
      process.env['DEBUG'] = '1';
      expect(getTimeoutMultiplier()).toBe(5);
    });
  });

  describe('getAdjustedTimeout', () => {
    it('should return base timeout with default multiplier', () => {
      expect(getAdjustedTimeout('unit')).toBe(10_000);
      expect(getAdjustedTimeout('e2e')).toBe(60_000);
    });

    it('should double timeouts in CI', () => {
      process.env['CI'] = 'true';
      expect(getAdjustedTimeout('unit')).toBe(20_000);
      expect(getAdjustedTimeout('e2e')).toBe(120_000);
    });

    it('should multiply timeouts by 5 in DEBUG mode', () => {
      process.env['DEBUG'] = 'true';
      expect(getAdjustedTimeout('unit')).toBe(50_000);
      expect(getAdjustedTimeout('e2e')).toBe(300_000);
    });

    it('should apply correct multiplier to all timeout types', () => {
      process.env['CI'] = 'true';
      expect(getAdjustedTimeout('unit')).toBe(TEST_TIMEOUTS.unit * 2);
      expect(getAdjustedTimeout('integration')).toBe(TEST_TIMEOUTS.integration * 2);
      expect(getAdjustedTimeout('database')).toBe(TEST_TIMEOUTS.database * 2);
      expect(getAdjustedTimeout('uiComponent')).toBe(TEST_TIMEOUTS.uiComponent * 2);
      expect(getAdjustedTimeout('e2e')).toBe(TEST_TIMEOUTS.e2e * 2);
      expect(getAdjustedTimeout('performance')).toBe(TEST_TIMEOUTS.performance * 2);
      expect(getAdjustedTimeout('heavy')).toBe(TEST_TIMEOUTS.heavy * 2);
    });

    it('should apply the dedicated multiplier without setting CI', () => {
      process.env['TEST_TIMEOUT_MULTIPLIER'] = '2';
      expect(process.env['CI']).toBeUndefined();
      expect(getAdjustedTimeout('uiComponent')).toBe(TEST_TIMEOUTS.uiComponent * 2);
      expect(getAdjustedTimeout('heavy')).toBe(TEST_TIMEOUTS.heavy * 2);
    });
  });
});
