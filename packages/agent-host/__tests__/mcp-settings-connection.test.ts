import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract';
import { StateStoreReadOnlyError } from '@brainstrike/state-store';
import { describe, expect, it, vi } from 'vitest';
import { type MessageConnection, ResponseError } from 'vscode-jsonrpc';
import type { HostMethodHandler } from '../src/auth-connection.js';
import { bindHostMcpSettingsMethods } from '../src/mcp-settings-connection.js';
import type { HostMcpSettingsService } from '../src/ports.js';
import type { HostMethod } from '../src/protocol.js';

function bound(setExtensions: () => Promise<unknown>) {
  const handlers = new Map<HostMethod, (params: unknown) => Promise<unknown>>();
  const handle: HostMethodHandler = (method, request) => {
    handlers.set(method, request as (params: unknown) => Promise<unknown>);
  };
  bindHostMcpSettingsMethods(
    handle,
    { sendNotification: vi.fn(async () => undefined) } as unknown as MessageConnection,
    { setExtensions } as unknown as HostMcpSettingsService,
    'desktop-ui'
  );
  const set = handlers.get('mcp/extensions/set');
  if (!set) {
    throw new Error('mcp/extensions/set was not bound');
  }
  return set;
}

/** BST-2144: an extension write the damaged state store refuses keeps its type. */
describe('host MCP settings methods', () => {
  it("keeps a read-only state store's refusal and other typed failures typed", async () => {
    await expect(
      bound(() => Promise.reject(new StateStoreReadOnlyError('row 1 missing from index')))({})
    ).rejects.toMatchObject({ failure: { code: 'state.read-only', kind: 'refusal' } });
    const closing = new BoundaryFailureError(
      refusal({ category: 'availability', code: 'host.closing', message: 'Closing.' })
    );
    await expect(bound(() => Promise.reject(closing))({})).rejects.toBe(closing);
  });

  it('shows any other failure as the host wrote it', async () => {
    const failed = await bound(() => Promise.reject(new Error('Extension id is invalid')))(
      {}
    ).catch((cause: unknown) => cause);
    expect(failed).toBeInstanceOf(ResponseError);
    expect(failed).toMatchObject({ message: 'Extension id is invalid' });
  });
});
