import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import { bindHostAuthMethods, type HostMethodHandler } from '../src/auth-connection.js';
import { HostPlatformLaunchOptionsSchema } from '../src/platform-launch-options.js';

/**
 * Greenfield (BST-1930): there are no users, so the host imports no retired
 * desktop credential store. The desktop's private client has no import method,
 * and a launch cannot hold credential use for one.
 */
describe('no legacy credential import', () => {
  it("binds no import method on the desktop's private client", () => {
    const methods: string[] = [];
    const handle: HostMethodHandler = (method) => {
      methods.push(method);
    };
    bindHostAuthMethods(handle, {} as MessageConnection, undefined, 'desktop-ui');
    expect(methods).toContain('auth/credential/set');
    expect(methods.filter((method) => method.includes('legacy'))).toEqual([]);
  });
  it('refuses a launch that declares a pending import', () => {
    expect(
      Schema.decodeUnknownResult(HostPlatformLaunchOptionsSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })({})._tag === 'Success'
    ).toBe(true);
    expect(
      Schema.decodeUnknownResult(HostPlatformLaunchOptionsSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })({ legacyImportPending: true })._tag === 'Success'
    ).toBe(false);
  });
});
