import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import {
  type AgentHost,
  attachAgentHost,
  authenticateHostClient,
  type HostClient,
  type HostPlatform,
  startAgentHost,
} from '@brainstrike/agent-host';
import {
  DEFAULT_PERMISSION_POLICIES,
  type OAuthProviderDescriptor,
} from '@brainstrike/assistant-contract';
import { expect, test } from 'vitest';
import { createMessageConnection, PortMessageReader, PortMessageWriter } from 'vscode-jsonrpc/node';
import { createHostAuthority, createHostCredentials } from '../src/index.js';

const PROVIDER = 'fixture-oauth-provider';
const AUTHORIZE_URL = 'https://issuer.invalid/oauth/authorize';

/** A loopback sign-in on an ephemeral port; nothing ever reaches the issuer. */
const descriptor: OAuthProviderDescriptor = {
  authorizeUrl: AUTHORIZE_URL,
  clientId: 'fixture-client',
  providerId: PROVIDER,
  redirectPath: '/callback',
  redirectPort: 0,
  scopes: ['openid'],
  tokenUrl: 'https://issuer.invalid/oauth/token',
};

/**
 * Opening a sign-in page is a client UI action: the host asks the desktop
 * client that requested `auth/connect` (`client/open-external`), never a
 * host-wide opener, and a public-socket client cannot start a flow at all.
 */
test('auth/connect asks its requesting desktop client to open the sign-in page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-client-open-external-'));
  const credentials = createHostCredentials({
    selection: { kind: 'file', path: join(root, 'credentials.json') },
  });
  const auth = createHostAuthority({ credentials, descriptors: [descriptor], env: {} });
  const platform: HostPlatform = {
    auth,
    close: async () => undefined,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    tools: {},
  };
  const opened = Promise.withResolvers<string>();
  let host: AgentHost | undefined;
  let desktop: HostClient | undefined;
  let socket: Awaited<ReturnType<typeof attachAgentHost>> | undefined;
  try {
    host = await startAgentHost({ lifetime: 'persistent', root }, platform);
    const channel = new MessageChannel();
    host.bindClientConnection(
      createMessageConnection(
        new PortMessageReader(channel.port2),
        new PortMessageWriter(channel.port2)
      ),
      'desktop-ui'
    );
    const connection = createMessageConnection(
      new PortMessageReader(channel.port1),
      new PortMessageWriter(channel.port1)
    );
    connection.onRequest('client/open-external', (input: { readonly url: string }) => {
      opened.resolve(input.url);
      return { opened: true };
    });
    const closed = new Promise<void>((resolve) => channel.port1.once('close', () => resolve()));
    desktop = await authenticateHostClient(
      connection,
      host.record,
      async () => {
        channel.port1.close();
      },
      closed
    );

    await expect(
      desktop.request('auth/connect', { method: 'loopback', provider: PROVIDER })
    ).resolves.toEqual({ state: 'awaiting_browser' });
    const url = new URL(await opened.promise);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get('client_id')).toBe('fixture-client');
    await expect(desktop.request('auth/cancel', { provider: PROVIDER })).resolves.toEqual({
      state: 'disconnected',
    });

    socket = await attachAgentHost(host.record);
    await expect(
      socket.request('auth/connect', { method: 'loopback', provider: PROVIDER })
    ).rejects.toMatchObject({
      failure: {
        category: 'authorization',
        code: 'auth.interactive-origin-required',
        kind: 'refusal',
        remedy: expect.any(String),
      },
    });
  } finally {
    await socket?.close();
    await desktop?.close();
    await host?.close();
    await credentials.close();
    await rm(root, { force: true, recursive: true });
  }
});
