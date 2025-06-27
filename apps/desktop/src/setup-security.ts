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
  console.log('🔒🔒🔒 SETUP SECURITY CALLED - isDev:', isDev, 'isPackaged:', app.isPackaged);
  console.error('🔒🔒🔒 SETUP SECURITY ERROR LOG - THIS SHOULD BE VISIBLE');

  // Always set CSP in Electron, even in dev mode
  // Development CSP - allows localhost connections and Hugging Face + CDNs
  const devCSP = "default-src 'self' http://localhost:* ws://localhost:*; script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* https://cdn.jsdelivr.net; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' http://localhost:*; img-src 'self' data: blob: http://localhost:*; font-src 'self' data: http://localhost:*; connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* wss://localhost:* https://huggingface.co https://*.hf.co https://cdn.jsdelivr.net; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
  
  // Production CSP - more restrictive but allows unsafe-eval for WASM (PGlite)
  // Allow connections to Hugging Face and its CDNs for model downloads
  const prodCSP = "default-src 'self'; script-src 'self' 'unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://huggingface.co https://*.hf.co https://cdn.jsdelivr.net; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

  const csp = isDev ? devCSP : prodCSP;
  const mode = isDev ? 'Development' : 'Production';

  session.defaultSession.webRequest.onHeadersReceived(
    (details: WebRequestDetails, callback: WebRequestCallback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
        },
      });
    }
  );
  
  console.info(`🔒 ${mode} CSP configured:`, csp);
  console.error(`🔒🔒🔒 ${mode} CSP ERROR LOG - CSP APPLIED:`, csp);
}
