import { afterEach, describe, expect, it, vi } from 'vitest';

describe('desktop renderer dev url', () => {
  const originalEnv = process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL'];
  const loggerWarn = vi.fn();

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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

  it('warns and falls back when the configured override is not a valid absolute url', async () => {
    process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL'] = 'not-a-url';
    vi.doMock('@brainstrike/utils/logger', () => ({
      createLogger: () => ({
        warn: loggerWarn,
      }),
    }));

    const { DESKTOP_DEV_RENDERER_PORT, DESKTOP_DEV_RENDERER_URL } = await import(
      '../desktop-renderer-url'
    );

    expect(DESKTOP_DEV_RENDERER_PORT).toBe(38_181);
    expect(DESKTOP_DEV_RENDERER_URL).toBe('http://localhost:38181');
    expect(loggerWarn).toHaveBeenCalledWith(
      'Ignoring invalid BRAINSTRIKE_DESKTOP_DEV_SERVER_URL override; expected an HTTP(S) URL with an explicit port.',
      {
        configuredUrl: 'not-a-url',
      }
    );
  });

  it('warns and falls back when the configured override omits an explicit port', async () => {
    process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL'] = 'http://localhost';
    vi.doMock('@brainstrike/utils/logger', () => ({
      createLogger: () => ({
        warn: loggerWarn,
      }),
    }));

    const { DESKTOP_DEV_RENDERER_PORT, DESKTOP_DEV_RENDERER_URL } = await import(
      '../desktop-renderer-url'
    );

    expect(DESKTOP_DEV_RENDERER_PORT).toBe(38_181);
    expect(DESKTOP_DEV_RENDERER_URL).toBe('http://localhost:38181');
    expect(loggerWarn).toHaveBeenCalledWith(
      'Ignoring invalid BRAINSTRIKE_DESKTOP_DEV_SERVER_URL override; expected an HTTP(S) URL with an explicit port.',
      {
        configuredUrl: 'http://localhost',
      }
    );
  });

  it('warns and falls back when the configured override uses a non-http scheme', async () => {
    process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL'] = 'ws://localhost:39191';
    vi.doMock('@brainstrike/utils/logger', () => ({
      createLogger: () => ({
        warn: loggerWarn,
      }),
    }));

    const { DESKTOP_DEV_RENDERER_PORT, DESKTOP_DEV_RENDERER_URL } = await import(
      '../desktop-renderer-url'
    );

    expect(DESKTOP_DEV_RENDERER_PORT).toBe(38_181);
    expect(DESKTOP_DEV_RENDERER_URL).toBe('http://localhost:38181');
    expect(loggerWarn).toHaveBeenCalledWith(
      'Ignoring invalid BRAINSTRIKE_DESKTOP_DEV_SERVER_URL override; expected an HTTP(S) URL with an explicit port.',
      {
        configuredUrl: 'ws://localhost:39191',
      }
    );
  });
});
