import { afterEach, describe, expect, it, vi } from 'vitest';

describe('desktop renderer dev url', () => {
  const originalEnv = process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL'];

  afterEach(() => {
    vi.resetModules();
    if (originalEnv === undefined) {
      Reflect.deleteProperty(process.env, 'BRAINSTRIKE_DESKTOP_DEV_SERVER_URL');
    } else {
      process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL'] = originalEnv;
    }
  });

  it('defaults to the dedicated desktop renderer port', async () => {
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_DESKTOP_DEV_SERVER_URL');

    const { DESKTOP_DEV_RENDERER_PORT, DESKTOP_DEV_RENDERER_URL } = await import(
      '../desktop-renderer-url'
    );

    expect(DESKTOP_DEV_RENDERER_PORT).toBe(38_181);
    expect(DESKTOP_DEV_RENDERER_URL).toBe('http://localhost:38181');
  });

  it('derives the port from the explicit desktop renderer url override', async () => {
    process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL'] = 'http://localhost:39191';

    const { DESKTOP_DEV_RENDERER_PORT, DESKTOP_DEV_RENDERER_URL } = await import(
      '../desktop-renderer-url'
    );

    expect(DESKTOP_DEV_RENDERER_PORT).toBe(39_191);
    expect(DESKTOP_DEV_RENDERER_URL).toBe('http://localhost:39191');
  });
});
