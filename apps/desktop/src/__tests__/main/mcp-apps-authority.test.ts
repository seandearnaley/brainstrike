import { EventEmitter } from 'node:events';
import type { McpAppToolAdmissionCapability } from '@brainstrike/agent';
import type { McpAppPrepareRequest } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { McpDesktopAppHost, type McpDesktopAppHostError } from '../../mcp/apps-authority';

class FakeWebContents extends EventEmitter {
  private destroyed = false;
  constructor(readonly id: number) {
    super();
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

const THREAD_A = 'thread-a';
const THREAD_B = 'thread-b';

const request = (preparationId: string, threadId = THREAD_A): McpAppPrepareRequest => ({
  arguments: { title: 'Issue' },
  origin: {
    mimeType: 'text/html;profile=mcp-app',
    resourceUri: 'ui://linear/editor',
    serverId: 'linear',
    toolName: 'open_editor',
  },
  preparationId,
  threadId,
  toolName: 'create_issue',
});

function admission(
  text = 'ok',
  execute = vi.fn(async () => ({ content: [{ text, type: 'text' }] }))
) {
  const capability: McpAppToolAdmissionCapability = {
    admit: vi.fn(() => ({
      decision: 'allow' as const,
      execute,
      riskCategory: 'mcp' as const,
    })),
    inadmissibleTools: [],
    serverIds: ['linear'],
  };
  return { capability, execute };
}

describe('McpDesktopAppHost', () => {
  it('prepares and executes one live-run ordinary call', async () => {
    const host = new McpDesktopAppHost();
    const sender = new FakeWebContents(41);
    const ordinary = admission();
    host.registerAdmission({ runId: 'run-1', threadId: THREAD_A }, ordinary.capability);

    await expect(host.prepare(sender, request('prep-1'))).resolves.toEqual({
      decision: 'allow',
      riskCategory: 'mcp',
    });
    await expect(host.execute(sender, { preparationId: 'prep-1' })).resolves.toEqual({
      result: { content: [{ text: 'ok', type: 'text' }] },
    });
    expect(ordinary.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects execute without prepare, replay, and execute after release', async () => {
    const host = new McpDesktopAppHost();
    const sender = new FakeWebContents(42);
    host.registerAdmission({ runId: 'run-1', threadId: THREAD_A }, admission().capability);

    await expect(host.execute(sender, { preparationId: 'missing' })).rejects.toThrow(
      /not available/u
    );
    await host.prepare(sender, request('once'));
    await host.execute(sender, { preparationId: 'once' });
    await expect(host.execute(sender, { preparationId: 'once' })).rejects.toThrow(/not available/u);
    await host.prepare(sender, request('released'));
    await host.release(sender, { preparationId: 'released' });
    await expect(host.execute(sender, { preparationId: 'released' })).rejects.toThrow(
      /not available/u
    );
  });

  it('fails closed with the typed no-live-run error', async () => {
    const host = new McpDesktopAppHost();
    await expect(host.prepare(new FakeWebContents(43), request('prep'))).rejects.toMatchObject({
      code: 'mcp_app_admission_unavailable',
    } satisfies Partial<McpDesktopAppHostError>);
  });

  it('resolves each thread to its own run when two threads share a server', async () => {
    const host = new McpDesktopAppHost();
    const sender = new FakeWebContents(46);
    const runA = admission('from-a');
    const runB = admission('from-b');
    host.registerAdmission({ runId: 'run-a', threadId: THREAD_A }, runA.capability);
    // Thread B's run registers LATER: recency must not win.
    host.registerAdmission({ runId: 'run-b', threadId: THREAD_B }, runB.capability);

    await host.prepare(sender, request('prep-a', THREAD_A));
    await host.prepare(sender, request('prep-b', THREAD_B));
    await expect(host.execute(sender, { preparationId: 'prep-a' })).resolves.toEqual({
      result: { content: [{ text: 'from-a', type: 'text' }] },
    });
    await expect(host.execute(sender, { preparationId: 'prep-b' })).resolves.toEqual({
      result: { content: [{ text: 'from-b', type: 'text' }] },
    });
    expect(runA.execute).toHaveBeenCalledTimes(1);
    expect(runB.execute).toHaveBeenCalledTimes(1);
  });

  it('fails typed for a thread with no admission even when another thread admits the server', async () => {
    const host = new McpDesktopAppHost();
    host.registerAdmission({ runId: 'run-b', threadId: THREAD_B }, admission().capability);

    await expect(
      host.prepare(new FakeWebContents(47), request('prep', THREAD_A))
    ).rejects.toMatchObject({ code: 'mcp_app_admission_unavailable' });
  });

  it('fails typed when the owning thread run does not admit the requested server', async () => {
    const host = new McpDesktopAppHost();
    const capability: McpAppToolAdmissionCapability = {
      ...admission().capability,
      serverIds: ['other'],
    };
    host.registerAdmission({ runId: 'run-a', threadId: THREAD_A }, capability);

    await expect(host.prepare(new FakeWebContents(48), request('prep'))).rejects.toMatchObject({
      code: 'mcp_app_admission_unavailable',
    });
  });

  it('fails closed after the owning run is disposed (no admission outlives its run)', async () => {
    const host = new McpDesktopAppHost();
    const sender = new FakeWebContents(49);
    const run = { runId: 'run-a', threadId: THREAD_A };
    host.registerAdmission(run, admission().capability);
    await host.prepare(sender, request('pending'));

    host.invalidateAdmission(run);

    await expect(host.execute(sender, { preparationId: 'pending' })).rejects.toThrow(
      /not available/u
    );
    await expect(host.prepare(sender, request('after'))).rejects.toMatchObject({
      code: 'mcp_app_admission_unavailable',
    });
  });

  it('lets a newer run of the same thread supersede the older admission', async () => {
    const host = new McpDesktopAppHost();
    const sender = new FakeWebContents(50);
    const older = admission('older');
    const newer = admission('newer');
    host.registerAdmission({ runId: 'run-1', threadId: THREAD_A }, older.capability);
    await host.prepare(sender, request('stale'));

    host.registerAdmission({ runId: 'run-2', threadId: THREAD_A }, newer.capability);

    // The superseded run's pending preparation is released, never executed.
    await expect(host.execute(sender, { preparationId: 'stale' })).rejects.toThrow(
      /not available/u
    );
    await host.prepare(sender, request('fresh'));
    await expect(host.execute(sender, { preparationId: 'fresh' })).resolves.toEqual({
      result: { content: [{ text: 'newer', type: 'text' }] },
    });
    expect(older.execute).not.toHaveBeenCalled();

    // Disposing the OLDER run later must not tear down the newer admission.
    host.invalidateAdmission({ runId: 'run-1', threadId: THREAD_A });
    await expect(host.prepare(sender, request('still-live'))).resolves.toMatchObject({
      decision: 'allow',
    });
  });

  it('rejects registering the same run twice', () => {
    const host = new McpDesktopAppHost();
    const run = { runId: 'run-1', threadId: THREAD_A };
    host.registerAdmission(run, admission().capability);
    expect(() => host.registerAdmission(run, admission().capability)).toThrow(
      /already registered/u
    );
  });

  it('force-releases a sender entries when its WebContents is destroyed', async () => {
    const host = new McpDesktopAppHost();
    const sender = new FakeWebContents(44);
    host.registerAdmission({ runId: 'run-1', threadId: THREAD_A }, admission().capability);
    await host.prepare(sender, request('destroyed'));

    sender.destroy();

    await expect(host.execute(sender, { preparationId: 'destroyed' })).rejects.toThrow(
      /not available/u
    );
    expect(sender.listenerCount('destroyed')).toBe(0);
  });
});
