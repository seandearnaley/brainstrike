import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSettingsHarness,
  type SettingsHarness,
  stdioServer,
} from './mcp-settings-authority-harness.js';

let harness: SettingsHarness | undefined;

afterEach(async () => {
  await harness?.authority.close().catch(() => undefined);
  await harness?.cleanup();
  harness = undefined;
});

const fs = parseConfiguredMcpServerId('fs');

describe('MCP settings authority status (BST-1930 c5b)', () => {
  it("reads the runtime's status, and the subscribe snapshot carries it", async () => {
    harness = await createSettingsHarness();
    await harness.writeConfig([stdioServer('fs')]);
    await harness.authority.start();

    const status = harness.authority.status();
    expect(status).toEqual(harness.publisher.snapshot());
    expect(status.servers).toEqual([
      expect.objectContaining({ configuredServerId: fs, state: 'disconnected' }),
    ]);
    await expect(harness.authority.snapshot()).resolves.toMatchObject({ status });
  });

  it("pushes each of the runtime's status revisions to subscribers", async () => {
    harness = await createSettingsHarness();
    await harness.writeConfig([stdioServer('fs')]);
    await harness.authority.start();
    const configured = harness.publisher.snapshot();
    await vi.waitFor(() =>
      expect(harness?.statusEvents.at(-1)).toEqual({ status: configured, type: 'status' })
    );

    const [server] = configured.servers;
    if (!server) {
      throw new Error('expected the configured server');
    }
    const connected = harness.publisher.publishActorTransition({
      ...server,
      negotiated: { era: 'legacy', revision: '2025-06-18' },
      state: 'connected',
    });

    await vi.waitFor(() =>
      expect(harness?.statusEvents.at(-1)).toEqual({ status: connected, type: 'status' })
    );
  });

  it('holds one runtime watch for all its subscribers and ends it on close', async () => {
    harness = await createSettingsHarness();
    const watch = vi.spyOn(harness.runtime.host, 'watch');
    const listener = vi.fn();
    harness.authority.subscribe(listener);
    // The harness's own subscriber already holds the one runtime watch.
    expect(watch).not.toHaveBeenCalled();

    await harness.authority.close();
    const published = harness.publisher.publishConfigSet([
      {
        configuredProtocol: 'legacy',
        configuredServerId: fs,
        generation: 1,
        state: 'disconnected',
        transport: 'stdio',
      },
    ]);
    // Delivery is a microtask after the publish; a live watch would have run by now.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(published.revision).toBe(1);
    expect(listener).not.toHaveBeenCalled();
    expect(harness.statusEvents).toEqual([]);
  });

  it('starts a fresh runtime watch for a subscriber after every earlier one left', async () => {
    harness = await createSettingsHarness();
    await harness.authority.close();
    const watch = vi.spyOn(harness.runtime.host, 'watch');
    const listener = vi.fn();
    const leave = harness.authority.subscribe(listener);
    expect(watch).toHaveBeenCalledTimes(1);

    const published = harness.publisher.publishConfigSet([
      {
        configuredProtocol: 'legacy',
        configuredServerId: fs,
        generation: 1,
        state: 'disconnected',
        transport: 'stdio',
      },
    ]);
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith({ status: published, type: 'status' })
    );
    leave();
    harness.publisher.publishConfigSet([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
