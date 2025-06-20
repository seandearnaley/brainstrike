import { isDevEnv } from '@brainstrike/utils';
import { app, session } from 'electron';

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

  if (isDev) {
    // Development CSP - allow localhost and dev tools (unsafe-eval needed for WASM)
    const devCSP =
      "default-src 'self' http://localhost:* ws://localhost:*; script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' http://localhost:*; img-src 'self' data: blob: http://localhost:*; font-src 'self' data: http://localhost:*; connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* wss://localhost:*; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

    session.defaultSession.webRequest.onHeadersReceived(
      (details: WebRequestDetails, callback: WebRequestCallback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [devCSP],
          },
        });
      }
    );

    if (isDevEnv()) {
      console.info('🔒 Development CSP configured');
    }
  } else {
    // Production CSP - more restrictive but allows unsafe-eval for WASM (PGlite)
    const prodCSP =
      "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

    session.defaultSession.webRequest.onHeadersReceived(
      (details: WebRequestDetails, callback: WebRequestCallback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [prodCSP],
          },
        });
      }
    );
  }
}
