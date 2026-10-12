import fsPromises from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import { createCommandSessionManager } from '../../assistant-server/command-session-manager';
import { requireToolExecute } from './_tool-test-helpers';

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!(address && typeof address === 'object')) {
    server.close();
    throw new Error('Unable to reserve a local test port.');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for command-session integration state.');
}

describe('persistent command-session native tools', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => fsPromises.rm(root, { force: true, recursive: true }))
    );
  });

  it('starts, lists, reads, writes to, and stops a real HTTP server PTY', async () => {
    const rootPath = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-command-session-tools-')
    );
    temporaryRoots.push(rootPath);
    const root = { displayName: 'api', path: rootPath, rootId: 'db-root-api' };
    const manager = createCommandSessionManager({
      resolver: { listRoots: () => Promise.resolve([root]) },
    });
    const runtime = { workspaceRoots: [root] } as RuntimeData;
    const tools = buildDesktopAssistantTools(runtime, { commandSessionManager: manager });
    const inspect = requireToolExecute(tools, 'brainstrike.inspectCommandSessions');
    const manage = requireToolExecute(tools, 'brainstrike.manageCommandSession');
    const port = await reservePort();
    const script = [
      "const http = require('node:http')",
      `const server = http.createServer((_request, response) => response.end('session-ok'))`,
      `server.listen(${port}, '127.0.0.1', () => console.log('BST_SESSION_READY'))`,
      "process.stdin.on('data', data => { if (data.toString().trim() === 'ping😀') console.log('BST_SESSION_PONG') })",
    ].join(';');
    await fsPromises.writeFile(path.join(rootPath, 'session-server.cjs'), script, 'utf8');

    try {
      const started = await manage({
        operation: {
          action: 'start',
          command: 'node session-server.cjs',
        },
        root: 'api',
      });
      expect(started).toMatchObject({ rootId: 'db-root-api', status: 'running' });

      expect(await inspect({ operation: { action: 'list' }, root: 'api' })).toMatchObject({
        rootId: 'db-root-api',
        sessions: [expect.objectContaining({ id: started.id, status: 'running' })],
      });

      const ready = await waitFor(async () => {
        const page = await inspect({
          operation: { action: 'read', cursor: 0, sessionId: started.id },
          root: 'api',
        });
        return page.output.includes('BST_SESSION_READY') ? page : undefined;
      });
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('session-ok');

      const writeResult = await manage({
        operation: { action: 'write', data: 'ping😀\r', sessionId: started.id },
        root: 'api',
      });
      expect(writeResult).toMatchObject({ writtenUtf16CodeUnits: 7 });
      await waitFor(async () => {
        const page = await inspect({
          operation: { action: 'read', cursor: ready.nextCursor, sessionId: started.id },
          root: 'api',
        });
        return page.output.includes('BST_SESSION_PONG') ? page : undefined;
      });

      await expect(
        manage({ operation: { action: 'stop', sessionId: started.id }, root: 'api' })
      ).resolves.toMatchObject({ status: 'exited' });
      await waitFor(async () => {
        try {
          await fetch(`http://127.0.0.1:${port}`);
          return;
        } catch {
          return true;
        }
      });
    } finally {
      await manager.dispose();
    }
  });
});
