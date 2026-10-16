import { afterEach, describe, expect, it } from 'vitest';
import { closeTabs, event, openTab, storeConfig } from './tabs';

afterEach(closeTabs);

const HELD = new URL('./held-extension-worker.ts', import.meta.url);

function within<T>(work: Promise<T>, ms: number): Promise<T | 'timed out'> {
  return Promise.race([
    work,
    new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), ms)),
  ]);
}

describe("the writer's request order and extensions", () => {
  it('serves a chat append while a concurrent extension op is still working, from every tab', async () => {
    const config = storeConfig();
    const writer = await openTab(config, HELD);
    const follower = await openTab(config, HELD);
    // Sent first through the writer's own worker, so every append below arrives after it.
    const held = writer.extension('held.wait', {});

    // Queued behind the held op, these appends would never answer.
    expect(await within(writer.append([event('thread-a', 1)]), 5000)).toMatchObject({ seqs: [1] });
    expect(await within(follower.append([event('thread-a', 2)]), 5000)).toMatchObject({
      seqs: [2],
    });

    expect(await follower.extension('held.release', {})).toBe('ok');
    expect(await held).toBe('released');
  });
});
