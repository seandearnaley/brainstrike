import { createLogger } from '@brainstrike/utils/logger';
import { app, session } from 'electron';
import { getCSP } from './csp-utils';

const logger = createLogger('DesktopSecurity');
export const desktopSecurityLogger = logger;

// Type definitions for Electron's webRequest
interface WebRequestDetails {
  responseHeaders?: Record<string, string[]>;
}

type WebRequestCallback = (response: { responseHeaders: Record<string, string[]> }) => void;

/**
 * Configure Content Security Policy headers based on environment.
 */
export function setupSecurity() {
  const isDev = !app.isPackaged;

  const csp = getCSP(isDev ? 'development' : 'production');
  const mode = isDev ? 'Development' : 'Production';

  session.defaultSession.webRequest.onHeadersReceived(
    (details: WebRequestDetails, callback: WebRequestCallback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
          'Permissions-Policy': ['camera=(), microphone=(), geolocation=(), payment=()'],
          'Referrer-Policy': ['strict-origin-when-cross-origin'],
          'X-Content-Type-Options': ['nosniff'],
          'X-Frame-Options': ['DENY'],
          'X-XSS-Protection': ['0'],
        },
      });
    }
  );

  logger.info('CSP configured', { mode, policy: csp });
}
