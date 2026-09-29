import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { DbHostRequestEnvelope } from '../../db-host-protocol';

type PostedMessage = DbHostRequestEnvelope;
class FakeUtilityProcess extends EventEmitter {
  readonly messages: PostedMessage[] = [];
  // Closing the host now waits for its exit: SIGTERM ends this fake, as it ends the real host.
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  });
  readonly postMessage = (message: PostedMessage): void => {
    this.messages.push(message);
  };
  reply(message: PostedMessage, result: unknown): void {
    this.emit('message', { id: message.id, kind: 'response', ok: true, result });
  }
}
const forkMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', isPackaged: false },
  utilityProcess: { fork: forkMock },
}));
function latestProcess(): FakeUtilityProcess {
  const host: unknown = forkMock.mock.results.at(-1)?.value;
  if (!(host instanceof FakeUtilityProcess)) {
    throw new Error('Expected a fake utility process.');
  }
  return host;
}
beforeEach(() => {
  vi.resetModules();
  forkMock.mockReset().mockImplementation(() => new FakeUtilityProcess());
});

it('retires retained clients when the default manager closes without resurrecting its host', async () => {
  const { closeDbHostManager, getDbHostManager } = await import('../../db-host-manager');
  const manager = getDbHostManager();
  const pendingDatabase = manager.getDatabase();
  const firstHost = latestProcess();
  firstHost.reply(firstHost.messages.at(-1) as PostedMessage, { initialized: true });
  const retainedDatabase = await pendingDatabase;
  const closing = closeDbHostManager();
  await expect(retainedDatabase.query('SELECT 0')).rejects.toThrow('DB host manager is retired.');
  await expect(manager.getDatabase()).rejects.toThrow('DB host manager is retired.');
  firstHost.reply(firstHost.messages.at(-1) as PostedMessage, { closed: true });
  await closing;

  const retainedQuery = retainedDatabase.query('SELECT 1');
  // Settle an incorrectly admitted request too: RED must not leak a request timer.
  if (latestProcess() !== firstHost) {
    latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { rows: [] });
  }
  await expect(retainedQuery).rejects.toThrow('DB host manager is retired.');
  await expect(manager.getDatabase()).rejects.toThrow('DB host manager is retired.');
  expect(forkMock).toHaveBeenCalledTimes(1);

  const replacement = getDbHostManager();
  const replacementDatabase = replacement.getDatabase();
  latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { initialized: true });
  const client = await replacementDatabase;
  const query = client.query('SELECT 2');
  latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, {
    rows: [{ value: 2 }],
  });
  await expect(query).resolves.toEqual({ rows: [{ value: 2 }] });
  expect(forkMock).toHaveBeenCalledTimes(2);
});

it('allows an explicitly closed manager to initialize a replacement host', async () => {
  const { createDbHostManager } = await import('../../db-host-manager');
  const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
  const first = manager.getDatabase();
  latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { initialized: true });
  await first;
  const closing = manager.close();
  latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { closed: true });
  await closing;
  const replacement = manager.getDatabase();
  latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { initialized: true });
  await expect(replacement).resolves.toBeDefined();
  expect(forkMock).toHaveBeenCalledTimes(2);
});

async function waitForLastRequest(kind: string): Promise<PostedMessage> {
  await vi.waitFor(() => expect(latestProcess().messages.at(-1)?.request.kind).toBe(kind));
  const request = latestProcess().messages.at(-1);
  if (!request) {
    throw new Error('Expected the utility host request.');
  }
  return request;
}

it('replaces the production db-main client identity across reinitialization and owner retirement', async () => {
  const { getDatabase, reinitializeDatabase } = await import('../../db-main');
  const { closeDbHostManager } = await import('../../db-host-manager');
  const firstPromise = getDatabase();
  const firstInit = await waitForLastRequest('init');
  latestProcess().reply(firstInit, { initialized: true });
  const first = await firstPromise;
  expect(await getDatabase()).toBe(first);

  const replacementPromise = reinitializeDatabase();
  const close = await waitForLastRequest('close');
  latestProcess().reply(close, { closed: true });
  const replacementInit = await waitForLastRequest('init');
  latestProcess().reply(replacementInit, { initialized: true });
  const replacement = await replacementPromise;
  expect(replacement).not.toBe(first);
  expect(await getDatabase()).toBe(replacement);

  const retired = closeDbHostManager();
  const retirementClose = await waitForLastRequest('close');
  latestProcess().reply(retirementClose, { closed: true });
  await retired;
  const afterRetirementPromise = getDatabase();
  const afterRetirementInit = await waitForLastRequest('init');
  latestProcess().reply(afterRetirementInit, { initialized: true });
  const afterRetirement = await afterRetirementPromise;
  expect(afterRetirement).not.toBe(replacement);
  expect(afterRetirement).not.toBe(first);
  await expect(replacement.query('SELECT 1')).rejects.toThrow('retired');
  const cleanup = closeDbHostManager();
  const cleanupClose = await waitForLastRequest('close');
  latestProcess().reply(cleanupClose, { closed: true });
  await cleanup;
});
