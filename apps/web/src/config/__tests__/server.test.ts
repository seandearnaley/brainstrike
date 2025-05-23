import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadModule = async () => await import('../server');

describe('server config', () => {
  beforeEach(() => {
    vi.resetModules();
    // biome-ignore lint/performance/noDelete lint/complexity/useLiteralKeys: required to remove env variable for testing
    delete process.env['PORT'];
  });

  it('DEFAULT_PORT respects process.env.PORT', async () => {
    // biome-ignore lint/complexity/useLiteralKeys: required for noPropertyAccessFromIndexSignature
    process.env['PORT'] = '1234';
    const { DEFAULT_PORT } = await loadModule();
    expect(DEFAULT_PORT).toBe(1234);
  });

  it('DEFAULT_PORT defaults to 3000 when PORT not set', async () => {
    const { DEFAULT_PORT } = await loadModule();
    expect(DEFAULT_PORT).toBe(3000);
  });

  it('getBaseUrl returns http://localhost:<port>', async () => {
    const { getBaseUrl } = await loadModule();
    expect(getBaseUrl(8080)).toBe('http://localhost:8080');
  });

  it('getPortsToCheck produces range from PORT_RANGE', async () => {
    // biome-ignore lint/complexity/useLiteralKeys: required for noPropertyAccessFromIndexSignature
    process.env['PORT'] = '4500';
    const mod = await loadModule();
    expect(mod.getPortsToCheck()).toEqual([4500, 4501, 4502, 4503, 4504, 4505]);
  });
});
