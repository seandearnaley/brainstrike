import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AgentEgressHost, type EgressUtility } from '../agent-egress/agent-egress-host';

/** A utility process that records what Main sends and replays scripted answers. */
class FakeUtility extends EventEmitter implements EgressUtility {
  readonly sent: unknown[] = [];
  killed = 0;
  readonly kill = (): boolean => {
    this.killed += 1;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  };
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  answer(message: unknown): void {
    this.emit('message', message);
  }
}

function harness() {
  const utilities: FakeUtility[] = [];
  const clock = { now: 1000 };
  const host = new AgentEgressHost(
    () => {
      const utility = new FakeUtility();
      utilities.push(utility);
      return utility;
    },
    () => clock.now
  );
  return { clock, host, utilities };
}

const LOOPBACK_REFUSAL = {
  address: '127.0.0.1',
  addressClass: 'loopback',
  host: 'internal.test',
  reason: 'destination',
} as const;

describe('AgentEgressHost (BST-1238)', () => {
  it('starts the proxy once with a fresh credential and answers its port', async () => {
    const { host, utilities } = harness();
    const first = host.ensure();
    const second = host.ensure();
    expect(utilities).toHaveLength(1);
    const [start] = (utilities[0]?.sent ?? []) as [{ credential: string; type: string }];
    expect(start.type).toBe('start');
    expect(start.credential).toMatch(/^agent:[0-9a-f]{64}$/u);
    utilities[0]?.answer({ port: 41_000, type: 'ready' });
    const egress = await first;
    expect(await second).toBe(egress);
    expect(egress).toEqual({
      password: start.credential.slice('agent:'.length),
      port: 41_000,
      username: 'agent',
    });
  });

  it('hands a fresh refusal to the one tunnel failure it explains', async () => {
    const { host, utilities } = harness();
    const ready = host.ensure();
    utilities[0]?.answer({ port: 1, type: 'ready' });
    await ready;
    utilities[0]?.answer({ refusal: LOOPBACK_REFUSAL, type: 'refusal' });
    expect(host.takeRefusal('other.test')).toBeUndefined();
    expect(host.takeRefusal('INTERNAL.test')).toEqual(LOOPBACK_REFUSAL);
    // Consumed: a later failure to the same host is not this refusal's.
    expect(host.takeRefusal('internal.test')).toBeUndefined();
  });

  it('never names a later failure with a stale refusal', async () => {
    const { clock, host, utilities } = harness();
    const ready = host.ensure();
    utilities[0]?.answer({ port: 1, type: 'ready' });
    await ready;
    utilities[0]?.answer({ refusal: LOOPBACK_REFUSAL, type: 'refusal' });
    clock.now += 5001;
    expect(host.takeRefusal('internal.test')).toBeUndefined();
  });

  it("drops a previous proxy's refusals when a new one starts", async () => {
    const { host, utilities } = harness();
    const first = host.ensure();
    utilities[0]?.answer({ port: 1, type: 'ready' });
    await first;
    utilities[0]?.answer({ refusal: LOOPBACK_REFUSAL, type: 'refusal' });
    utilities[0]?.emit('exit', 1);
    const second = host.ensure();
    utilities[1]?.answer({ port: 2, type: 'ready' });
    await second;
    expect(host.takeRefusal('internal.test')).toBeUndefined();
  });

  it.each([
    ['a failed start', { message: 'EADDRINUSE', type: 'failed' }, /failed to start: EADDRINUSE/u],
    ['an out-of-protocol message', { port: 'not a port', type: 'ready' }, /invalid message/u],
  ])(
    'rejects %s, kills the proxy and starts a fresh one next time',
    async (_label, answer, error) => {
      const { host, utilities } = harness();
      const ready = host.ensure();
      utilities[0]?.answer(answer);
      await expect(ready).rejects.toThrow(error);
      expect(utilities[0]?.killed).toBe(1);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const retry = host.ensure();
      expect(utilities).toHaveLength(2);
      utilities[1]?.answer({ port: 2, type: 'ready' });
      expect((await retry).port).toBe(2);
    }
  );

  // ADR-0026 R2: a slow start is load, not death; only the proxy's exit ends it.
  it('waits for a slow proxy to start, and never kills it for being slow', async () => {
    const { host, utilities } = harness();
    let settled = false;
    const slow = host.ensure().finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    utilities[0]?.answer({ port: 1, type: 'ready' });
    expect((await slow).port).toBe(1);
    expect(utilities[0]?.killed).toBe(0);
  });

  it('replaces a proxy that exits after it was ready on the next ensure', async () => {
    const { host, utilities } = harness();
    const first = host.ensure();
    utilities[0]?.answer({ port: 1, type: 'ready' });
    await first;
    utilities[0]?.emit('exit', 1);
    const second = host.ensure();
    expect(utilities).toHaveLength(2);
    utilities[1]?.answer({ port: 2, type: 'ready' });
    expect((await second).port).toBe(2);
  });

  it('close kills the proxy and joins its exit', async () => {
    const { host, utilities } = harness();
    const ready = host.ensure();
    utilities[0]?.answer({ port: 1, type: 'ready' });
    await ready;
    let exited = false;
    utilities[0]?.once('exit', () => {
      exited = true;
    });
    await host.close();
    expect(utilities[0]?.killed).toBe(1);
    expect(exited).toBe(true);
  });
});
