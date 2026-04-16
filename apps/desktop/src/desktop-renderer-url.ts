import { createLogger } from '@brainstrike/utils/logger';

const DEFAULT_DESKTOP_DEV_RENDERER_PORT = 38_181;
const logger = createLogger('DesktopRendererUrl');

function buildDefaultDesktopDevRendererUrl(): string {
  return `http://localhost:${DEFAULT_DESKTOP_DEV_RENDERER_PORT}`;
}

function warnInvalidDesktopDevRendererUrl(configuredUrl: string): void {
  logger.warn(
    'Ignoring invalid BRAINSTRIKE_DESKTOP_DEV_SERVER_URL override; expected an absolute URL with an explicit port.',
    {
      configuredUrl,
    }
  );
}

function resolveDesktopDevRendererPort(): number {
  const configuredUrl = process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']?.trim();
  if (!configuredUrl) {
    return DEFAULT_DESKTOP_DEV_RENDERER_PORT;
  }

  try {
    const parsedUrl = new URL(configuredUrl);
    const parsedPort = Number.parseInt(parsedUrl.port, 10);
    if (Number.isFinite(parsedPort) && parsedPort > 0) {
      return parsedPort;
    }
    warnInvalidDesktopDevRendererUrl(configuredUrl);
    return DEFAULT_DESKTOP_DEV_RENDERER_PORT;
  } catch {
    warnInvalidDesktopDevRendererUrl(configuredUrl);
    return DEFAULT_DESKTOP_DEV_RENDERER_PORT;
  }
}

export const DESKTOP_DEV_RENDERER_PORT = resolveDesktopDevRendererPort();
export const DESKTOP_DEV_RENDERER_URL = (() => {
  const configuredUrl = process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']?.trim();
  if (!configuredUrl) {
    return buildDefaultDesktopDevRendererUrl();
  }

  try {
    const parsedUrl = new URL(configuredUrl);
    if (parsedUrl.port) {
      return configuredUrl;
    }
  } catch {
    return buildDefaultDesktopDevRendererUrl();
  }

  return buildDefaultDesktopDevRendererUrl();
})();
