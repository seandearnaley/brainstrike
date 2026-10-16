import { afterEach, describe, expect, it } from 'vitest';
import type { WebStateLogAppend } from '../protocol';
import type { WebStateStore } from '../web-state-client';
import { closeTabs, event, nextLease, openTab, rejection, storeConfig } from './tabs';

afterEach(closeTabs);

/** Every announcement a tab hears, in order. */
function heard(tab: WebStateStore): WebStateLogAppend[] {
  const appends: WebStateLogAppend[] = [];
  tab.subscribeLog((append) => appends.push(append));
  return appends;
}

describe("the browser writer's announcement of committed rows (BST-1940)", () => {
  it("tells every tab each thread's committed rows, the appending tab too", async () => {
    const config = storeConfig();
    const writerTab = await openTab(config);
    const otherTab = await openTab(config);
    const byWriter = heard(writerTab);
    const byOther = heard(otherTab);

    await otherTab.append([event('a', 1), event('b', 1), event('a', 2)]);
    const announced = [
      { seqs: [1, 2], threadId: 'a' },
      { seqs: [1], threadId: 'b' },
    ];
    await expect.poll(() => byOther).toEqual(announced);
    await expect.poll(() => byWriter).toEqual(announced);

    await writerTab.append([event('a', 3)]);
    await expect.poll(() => byOther.at(-1)).toEqual({ seqs: [3], threadId: 'a' });
    // A tab that hears of rows reads them: the announcement follows their commit.
    const read = await otherTab.read('a', 3, 10);
    expect(read.rows.map((row) => row.seq)).toEqual([3]);
  });

  it('keeps telling the tabs once the writing passes to another tab', async () => {
    const config = storeConfig();
    const first = await openTab(config);
    const second = await openTab(config);
    const third = await openTab(config);
    const byThird = heard(third);

    const leases = [nextLease(second), nextLease(third)];
    first.close();
    await Promise.all(leases);
    const writer = second.lease.leader ? second : third;
    expect(writer.lease.leader).toBe(true);

    await second.append([event('after', 1)]);
    await expect.poll(() => byThird).toEqual([{ seqs: [1], threadId: 'after' }]);
  });

  it('announces nothing for an append it refused', async () => {
    const config = storeConfig();
    const writerTab = await openTab(config);
    const otherTab = await openTab(config);
    const byOther = heard(otherTab);

    const blob = 'a'.repeat(64);
    await rejection(
      writerTab.append([
        ['refused', 'tool.output', 'run-1', JSON.stringify({ blob, type: 'tool.output' }), null, 1],
      ])
    );
    await writerTab.append([event('kept', 1)]);
    await expect.poll(() => byOther).toEqual([{ seqs: [1], threadId: 'kept' }]);
  });
});
