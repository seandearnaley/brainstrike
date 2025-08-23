import { getCSP } from '@brainstrike/security';
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

  let csp = getCSP(isDev ? 'development' : 'production');
  const mode = isDev ? 'Development' : 'Production';

  // Electron requires script-src to allow blob: in production for certain WASM/loader patterns.
  // If the shared CSP removed it for hardening, append it here for desktop only.
  if (!isDev) {
    const scriptMatch = csp.match(/script-src[^;]*/);
    if (scriptMatch && !/\bblob:/.test(scriptMatch[0] ?? '')) {
      const updated = `${scriptMatch[0]} blob:`;
      csp = csp.replace(scriptMatch[0] as string, updated);
    }
  }

  session.defaultSession.webRequest.onHeadersReceived(
    (details: WebRequestDetails, callback: WebRequestCallback) => {
      callback({
        responseHeaders: {
          ...(details.responseHeaders ?? {}),
          'Content-Security-Policy': [csp],
        },
      });
    }
  );

  console.info(`🔒 ${mode} CSP configured:`, csp);
}
