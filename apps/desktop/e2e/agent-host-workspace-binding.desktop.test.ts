import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { seedRoot } from './utils/seed-root';

test('ordinary app Main validates a committed host root through its actual catalog and pinned registry', async ({
  window: page,
  electron,
}) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m3-main-binding-app-')));
  const rootId = randomUUID();
  writeFileSync(path.join(root, 'bound-evidence.ts'), 'export const bound = true;\n');
  try {
    await seedRoot(page, root, {
      disableBackgroundIndexing: true,
      reloadReason: 'm3-main-binding-owner',
      rootId,
    });
    await expect(page.getByText('bound-evidence.ts').first()).toBeVisible();
    const result = await page.evaluate(
      async ({ expectedRootId, expectedPath }) => {
        const bridge = (
          window as Window & { agentHost?: { connect(requestId: string): Promise<void> } }
        ).agentHost;
        const files = window.electronAPI?.fileSystem;
        if (!(bridge && files)) {
          throw new Error('Ordinary app owner capabilities are unavailable');
        }
        const reply = await files.restoreRoots();
        if (!reply.ok) {
          throw new Error(reply.error.message);
        }
        const rows = reply.value
          .filter((root) => root.rootId === expectedRootId)
          .map((root) => ({
            id: root.rootId,
            path: root.handle.path,
            permissionState: root.permissionState,
          }));
        const requestId = crypto.randomUUID();
        const transferred = Promise.withResolvers<{
          port: MessagePort;
          record: { token: string; protocolVersion: number; hostVersion: string };
        }>();
        const disconnected = Promise.withResolvers<void>();
        const receive = (event: MessageEvent<unknown>): void => {
          if (event.source !== window || !event.data || typeof event.data !== 'object') {
            return;
          }
          const data = event.data;
          if (
            !('payload' in data && data.payload) ||
            typeof data.payload !== 'object' ||
            !('requestId' in data.payload) ||
            data.payload.requestId !== requestId
          ) {
            return;
          }
          if ('type' in data && data.type === 'agent-host/disconnected') {
            disconnected.resolve();
          }
          if ('type' in data && data.type === 'agent-host/connected' && 'record' in data.payload) {
            const port = event.ports[0];
            if (!port) {
              throw new Error('App host did not transfer a port');
            }
            transferred.resolve({
              port,
              record: data.payload.record as {
                token: string;
                protocolVersion: number;
                hostVersion: string;
              },
            });
          }
        };
        window.addEventListener('message', receive);
        let port: MessagePort | undefined;
        try {
          await bridge.connect(requestId);
          const connection = await transferred.promise;
          port = connection.port;
          port.start();
          const request = (method: string, params: unknown): Promise<unknown> => {
            const reply = Promise.withResolvers<unknown>();
            const id = crypto.randomUUID();
            const response = (
              event: MessageEvent<{ id?: string; error?: unknown; result?: unknown }>
            ): void => {
              if (event.data.id !== id) {
                return;
              }
              connection.port.removeEventListener('message', response);
              if (event.data.error) {
                reply.reject(event.data.error);
              } else {
                reply.resolve(event.data.result);
              }
            };
            connection.port.addEventListener('message', response);
            connection.port.postMessage({ id, jsonrpc: '2.0', method, params });
            return reply.promise;
          };
          await request('initialize', {
            hostVersion: connection.record.hostVersion,
            protocolVersion: connection.record.protocolVersion,
            token: connection.record.token,
          });
          const started = (await request('thread/start', { commandId: crypto.randomUUID() })) as {
            threadId: string;
          };
          const binding = {
            operatingRootDisplayName: 'Bound app workspace',
            operatingRootId: expectedRootId,
            operatingRootPath: expectedPath,
          };
          const command = {
            commandId: crypto.randomUUID(),
            patch: binding,
            threadId: started.threadId,
          };
          const accepted = await request('thread/workspace/binding/update', command);
          await request('thread/workspace/binding/update', command);
          let rejected = false;
          try {
            await request('thread/workspace/binding/update', {
              commandId: crypto.randomUUID(),
              patch: {
                operatingRootDisplayName: 'Forged snapshot',
                operatingRootId: crypto.randomUUID(),
                operatingRootPath: expectedPath,
              },
              threadId: started.threadId,
            });
          } catch {
            rejected = true;
          }
          const current = await request('thread/workspace/binding/read', {
            threadId: started.threadId,
          });
          const committed = (await request('thread/read', {
            fromSeq: 0,
            threadId: started.threadId,
          })) as { rows: { event: { type: string } }[] };
          return {
            accepted,
            binding,
            current,
            rejected,
            rootRows: rows,
            updates: committed.rows.filter(
              ({ event }) => event.type === 'workspace.binding.updated'
            ).length,
          };
        } finally {
          port?.close();
          if (port) {
            await disconnected.promise;
          }
          window.removeEventListener('message', receive);
        }
      },
      { expectedPath: root, expectedRootId: rootId }
    );
    expect(result.rootRows).toEqual([{ id: rootId, path: root, permissionState: 'granted' }]);
    expect(result.accepted).toEqual({ accepted: true });
    expect(result.rejected).toBe(true);
    expect(result.current).toEqual({ binding: result.binding });
    expect(result.updates).toBe(1);
  } finally {
    await electron.dispose();
    rmSync(root, { force: true, recursive: true });
  }
});
