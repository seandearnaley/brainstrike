/**
 * The single `protocol.registerSchemesAsPrivileged` call for the app.
 *
 * Electron honors this method ONCE per launch ("can be called only once"), and
 * it must run before `app.whenReady()`. A second call does not merge — it
 * silently replaces or rejects the earlier registration, stripping the first
 * scheme of its privileges. Every privileged scheme therefore exports a
 * descriptor and registers HERE; no module may call
 * `registerSchemesAsPrivileged` itself. (Caught by Codex review on PR #2290.)
 */
import { protocol } from 'electron';
import { ASSET_PROTOCOL_PRIVILEGE } from './asset-protocol';
import { CANVAS_PROTOCOL_PRIVILEGE } from './canvas-protocol';
import { MCP_APP_SHELL_PROTOCOL_PRIVILEGE } from './mcp/apps-shell-protocol';
import { APP_RENDERER_PROTOCOL_PRIVILEGE } from './renderer-protocol';

export const PRIVILEGED_SCHEMES = [
  APP_RENDERER_PROTOCOL_PRIVILEGE,
  ASSET_PROTOCOL_PRIVILEGE,
  CANVAS_PROTOCOL_PRIVILEGE,
  MCP_APP_SHELL_PROTOCOL_PRIVILEGE,
];

/** MUST run before `app.whenReady()`, exactly once. */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged(
    PRIVILEGED_SCHEMES.map((entry) => ({
      privileges: { ...entry.privileges },
      scheme: entry.scheme,
    }))
  );
}
