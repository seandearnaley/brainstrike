import { createLogger } from '@brainstrike/logging';
import { app, session } from 'electron';
import { CANVAS_PROTOCOL_SCHEME } from './canvas-protocol';
import { getCSP } from './csp-utils';
import { installMcpAppSessionPolicy } from './mcp/apps-session-policy';
import { MCP_APP_SHELL_PROTOCOL_SCHEME } from './mcp/apps-shell-protocol';

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
      // The sandbox shells own their headers: the canvas-protocol handler
      // (brainstrike-canvas:, BST-1173) and the MCP App shell protocol handler
      // (brainstrike-mcp-app:, BST-1572) each serve their reviewed sandbox
      // CSP on every response. Stamping the app policy here would re-impose
      // X-Frame-Options: DENY (making the shell unframeable) and attach a CSP
      // the nested srcdoc would inherit — silently breaking inline sandbox
      // scripts in production only.
      if (
        details.url?.startsWith(`${CANVAS_PROTOCOL_SCHEME}:`) ||
        details.url?.startsWith(`${MCP_APP_SHELL_PROTOCOL_SCHEME}:`)
      ) {
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

  // The main window (and every other window on the default session) also gets
  // the MCP App sandbox permission/download policy — the header stamp above
  // deliberately skips the shell scheme, so the shell's own Permissions-Policy
  // is all the frame carries and features outside Permissions-Policy (e.g.
  // notifications) would otherwise reach Electron's grant-everything default.
  installMcpAppSessionPolicy(session.defaultSession);

  logger.info('CSP configured', { mode, policy: csp });
}
