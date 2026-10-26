// @vitest-environment node
import { PassThrough } from 'node:stream';
import {
  createWorktreeLedgerClient,
  serveWorktreeLedgerStore,
} from '@brainstrike/agent-host/catalog';
import type { WorktreeLedgerPort } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';

function transport(store: WorktreeLedgerPort) {
  const requests = new PassThrough();
  const responses = new PassThrough();
  const main = createMessageConnection(
    new StreamMessageReader(responses),
    new StreamMessageWriter(requests)
  );
  const host = createMessageConnection(
    new StreamMessageReader(requests),
    new StreamMessageWriter(responses)
  );
  const serving = serveWorktreeLedgerStore(host, store);
  main.listen();
  host.listen();
  return {
    client: createWorktreeLedgerClient(main),
    close: async () => {
      await serving.close();
      main.dispose();
      host.dispose();
      requests.destroy();
      responses.destroy();
    },
    main,
    serving,
  };
}

test('private worktree ledger RPC answers canonical operations and rejects noncanonical ones', async () => {
  const worktreeLedger = vi.fn<WorktreeLedgerPort['worktreeLedger']>(async () => ({ rows: [] }));
  const fixture = transport({ worktreeLedger });
  try {
    await expect(fixture.client.worktreeLedger({ operation: 'list-active' })).resolves.toEqual({
      rows: [],
    });
    await expect(
      fixture.main.sendRequest('host/worktree-ledger', {
        operation: 'query',
        sql: 'DELETE FROM brainstrike_worktrees',
      })
    ).rejects.toThrow();
    expect(worktreeLedger).toHaveBeenCalledTimes(1);
  } finally {
    await fixture.close();
  }
});

test('endpoint close fences new requests and joins the already admitted writer operation', async () => {
  const entered = Promise.withResolvers<void>();
  const committed = Promise.withResolvers<void>();
  const fixture = transport({
    worktreeLedger: async () => {
      entered.resolve();
      await committed.promise;
      return { rows: [] };
    },
  });
  try {
    const work = fixture.client.worktreeLedger({ id: 'worktree-alpha', operation: 'restore' });
    await entered.promise;
    let closed = false;
    const closing = fixture.serving.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(fixture.client.worktreeLedger({ operation: 'list-active' })).rejects.toThrow();
    committed.resolve();
    await work;
    await closing;
    expect(closed).toBe(true);
  } finally {
    committed.resolve();
    await fixture.close();
  }
});
