import { describe, expect, it } from 'vitest';
import { detectTestEnvironment } from '../test-environment';

describe('detectTestEnvironment', () => {
  it('detects the real vitest environment by default', () => {
    expect(detectTestEnvironment()).toBe(true);
  });

  it('returns false for a bare global record', () => {
    expect(detectTestEnvironment({})).toBe(false);
  });

  it('returns false when NODE_ENV is non-test and no framework markers exist', () => {
    expect(detectTestEnvironment({ process: { env: { NODE_ENV: 'development' } } })).toBe(false);
  });

  it('detects NODE_ENV=test', () => {
    expect(detectTestEnvironment({ process: { env: { NODE_ENV: 'test' } } })).toBe(true);
  });

  it('detects the vitest global marker', () => {
    expect(detectTestEnvironment({ vitest: {} })).toBe(true);
  });

  it('detects the jest global marker', () => {
    expect(detectTestEnvironment({ jest: {} })).toBe(true);
  });

  it('detects the vitest worker marker', () => {
    expect(detectTestEnvironment({ __vitest_worker__: {} })).toBe(true);
  });

  it('ignores a process value without env', () => {
    expect(detectTestEnvironment({ process: {} })).toBe(false);
  });
});
