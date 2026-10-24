import { describe, expect, it, vi } from 'vitest';
import type { CdpSession } from '../browser-driver';
import { DebuggerBrowserDriver } from '../debugger-browser-driver';

/** Records CDP calls and replays canned per-method responses. */
class FakeCdpSession implements CdpSession {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  detached = false;
  private readonly responses: Record<string, unknown>;

  constructor(responses: Record<string, unknown> = {}) {
    this.responses = responses;
  }
  send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.sent.push({ method, params });
    return Promise.resolve((this.responses[method] ?? {}) as T);
  }
  on(): void {
    // no-op for these tests
  }
  detach(): void {
    this.detached = true;
  }
}

function driverWith(session: CdpSession): DebuggerBrowserDriver {
  return new DebuggerBrowserDriver(() => Promise.resolve(session));
}

describe('DebuggerBrowserDriver', () => {
  it('snapshot enables the Accessibility domain and formats the full AX tree', async () => {
    const session = new FakeCdpSession({
      'Accessibility.getFullAXTree': {
        nodes: [
          { childIds: ['2'], nodeId: '1', role: { value: 'RootWebArea' } },
          { backendDOMNodeId: 7, name: { value: 'Go' }, nodeId: '2', role: { value: 'button' } },
        ],
      },
    });
    const result = await driverWith(session).snapshot({ filter: 'all', maxChars: 5000 });

    expect(session.sent.map((c) => c.method)).toContain('Accessibility.enable');
    expect(result.text).toBe(['RootWebArea', '  button "Go" [ref=e1]'].join('\n'));
    expect(result.refs).toEqual({ e1: 7 });
  });

  it('screenshot returns a PNG data URL and maps a region to a CDP clip', async () => {
    const session = new FakeCdpSession({ 'Page.captureScreenshot': { data: 'QUJD' } });
    const driver = driverWith(session);

    const full = await driver.screenshot();
    expect(full.dataUrl).toBe('data:image/png;base64,QUJD');

    await driver.screenshot({ region: { height: 40, width: 30, x: 10, y: 20 } });
    const clipCall = session.sent.find((c) => c.method === 'Page.captureScreenshot' && c.params);
    expect(clipCall?.params).toEqual({
      captureBeyondViewport: true,
      clip: { height: 40, scale: 1, width: 30, x: 10, y: 20 },
    });
  });

  it('throws (never coerces) when a CDP reply is malformed — NO SILENT FALLBACKS', async () => {
    await expect(
      driverWith(new FakeCdpSession({})).snapshot({ filter: 'all', maxChars: 100 })
    ).rejects.toThrow('no nodes array');
    await expect(driverWith(new FakeCdpSession({})).screenshot()).rejects.toThrow('no image data');
    await expect(
      driverWith(new FakeCdpSession({ 'Runtime.evaluate': { result: { value: 42 } } })).getPageText(
        10
      )
    ).rejects.toThrow('did not return page text');
  });

  it('throws on a malformed AX node element (not just a missing array)', async () => {
    const session = new FakeCdpSession({ 'Accessibility.getFullAXTree': { nodes: [{}] } });
    await expect(driverWith(session).snapshot({ filter: 'all', maxChars: 100 })).rejects.toThrow(
      'malformed node'
    );
  });

  it('throws when a consumed AX field has the wrong type (e.g. non-number backendDOMNodeId)', async () => {
    // A string backendDOMNodeId would otherwise become a string-valued ref.
    const bad = { backendDOMNodeId: 'bad', nodeId: '1', role: { value: 'button' } };
    const session = new FakeCdpSession({ 'Accessibility.getFullAXTree': { nodes: [bad] } });
    await expect(driverWith(session).snapshot({ filter: 'all', maxChars: 100 })).rejects.toThrow(
      'malformed node'
    );
  });

  it('accepts a genuinely empty page (empty string is valid, not malformed)', async () => {
    const session = new FakeCdpSession({ 'Runtime.evaluate': { result: { value: '' } } });
    const result = await driverWith(session).getPageText(10);
    expect(result).toEqual({ text: '', truncated: false });
  });

  it('getPageText reads innerText via Runtime.evaluate and truncates to maxChars', async () => {
    const session = new FakeCdpSession({
      'Runtime.evaluate': { result: { value: 'hello world' } },
    });
    const result = await driverWith(session).getPageText(5);

    expect(result.text).toBe('hello');
    expect(result.truncated).toBe(true);
  });

  it('resolves a fresh session per call (so it always targets the active tab)', async () => {
    const session = new FakeCdpSession({
      'Page.captureScreenshot': { data: 'QUJD' },
      'Runtime.evaluate': { result: { value: 'x' } },
    });
    const resolveSession = vi.fn(() => Promise.resolve(session));
    const driver = new DebuggerBrowserDriver(resolveSession);
    await driver.getPageText(100);
    await driver.screenshot();
    expect(resolveSession).toHaveBeenCalledTimes(2);
  });
});
