import { createLogger } from '@brainstrike/logging';
import { resolveDesktopDevRendererConfig } from './desktop-renderer-config';

const logger = createLogger('DesktopRendererUrl');

function warnInvalidDesktopDevRendererUrl(configuredUrl: string): void {
  logger.warn(
    'Ignoring invalid BRAINSTRIKE_DESKTOP_DEV_SERVER_URL override; expected an HTTP(S) URL with an explicit port.',
    {
      configuredUrl,
    }
  );
}

const resolvedDesktopDevRendererConfig = resolveDesktopDevRendererConfig(
  process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']
);
if (resolvedDesktopDevRendererConfig.kind === 'invalid-override') {
  warnInvalidDesktopDevRendererUrl(resolvedDesktopDevRendererConfig.configuredUrl);
}

export const DESKTOP_DEV_RENDERER_PORT = resolvedDesktopDevRendererConfig.port;
export const DESKTOP_DEV_RENDERER_URL = resolvedDesktopDevRendererConfig.url;
