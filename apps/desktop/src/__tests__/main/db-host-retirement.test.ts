import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { DbHostRequestEnvelope } from '../../db-host-protocol';

type PostedMessage = DbHostRequestEnvelope;
class FakeUtilityProcess extends EventEmitter {
  readonly messages: PostedMessage[] = [];
  readonly kill = vi.fn(() => true);
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
