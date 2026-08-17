import { createLogger } from '@brainstrike/logging';
import { app, session } from 'electron';
import { CANVAS_PROTOCOL_SCHEME } from './canvas-protocol';
import { getCSP } from './csp-utils';

const logger = createLogger('DesktopSecurity');
export const desktopSecurityLogger = logger;

// Type definitions for Electron's webRequest
interface WebRequestDetails {
  responseHeaders?: Record<string, string[]>;
  url?: string;
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
      // The Canvas sandbox shell (brainstrike-canvas:) owns its headers: the
      // canvas-protocol handler serves the reviewed sandbox CSP on every
      // response. Stamping the app policy here would re-impose
      // X-Frame-Options: DENY (making the shell unframeable) and attach a CSP
      // the nested srcdoc would inherit — silently breaking inline canvas
      // scripts in production only. See canvas-protocol.ts (BST-1173).
      if (details.url?.startsWith(`${CANVAS_PROTOCOL_SCHEME}:`)) {
        callback({ responseHeaders: { ...details.responseHeaders } });
        return;
      }
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
