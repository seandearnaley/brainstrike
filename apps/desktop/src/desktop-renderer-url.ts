import { createLogger } from '@brainstrike/utils/logger';

const DEFAULT_DESKTOP_DEV_RENDERER_PORT = 38_181;
const logger = createLogger('DesktopRendererUrl');

function buildDefaultDesktopDevRendererUrl(): string {
  return `http://localhost:${DEFAULT_DESKTOP_DEV_RENDERER_PORT}`;
}

interface ResolvedDesktopDevRendererConfig {
  port: number;
  url: string;
}

function warnInvalidDesktopDevRendererUrl(configuredUrl: string): void {
  logger.warn(
    'Ignoring invalid BRAINSTRIKE_DESKTOP_DEV_SERVER_URL override; expected an HTTP(S) URL with an explicit port.',
    {
      configuredUrl,
    }
  );
}

function resolveDesktopDevRendererConfig(): ResolvedDesktopDevRendererConfig {
  const configuredUrl = process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']?.trim();
  if (!configuredUrl) {
    return {
      port: DEFAULT_DESKTOP_DEV_RENDERER_PORT,
      url: buildDefaultDesktopDevRendererUrl(),
    };
  }

  try {
    const parsedUrl = new URL(configuredUrl);
    const parsedPort = Number.parseInt(parsedUrl.port, 10);
    const isHttpRendererUrl = parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    if (isHttpRendererUrl && Number.isFinite(parsedPort) && parsedPort > 0) {
      return {
        port: parsedPort,
        url: configuredUrl,
      };
    }
    warnInvalidDesktopDevRendererUrl(configuredUrl);
    return {
      port: DEFAULT_DESKTOP_DEV_RENDERER_PORT,
      url: buildDefaultDesktopDevRendererUrl(),
    };
  } catch {
    warnInvalidDesktopDevRendererUrl(configuredUrl);
    return {
      port: DEFAULT_DESKTOP_DEV_RENDERER_PORT,
      url: buildDefaultDesktopDevRendererUrl(),
    };
  }
}

const resolvedDesktopDevRendererConfig = resolveDesktopDevRendererConfig();
export const DESKTOP_DEV_RENDERER_PORT = resolvedDesktopDevRendererConfig.port;
export const DESKTOP_DEV_RENDERER_URL = resolvedDesktopDevRendererConfig.url;
