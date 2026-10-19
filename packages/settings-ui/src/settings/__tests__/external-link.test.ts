import type { MouseEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openExternalLink } from '../external-link';

const LINK = 'https://example.test/docs';

function clickEvent() {
  const preventDefault = vi.fn();
  return { event: { preventDefault } as unknown as MouseEvent<HTMLAnchorElement>, preventDefault };
}

function installOpenExternal(openExternal: (target: string) => Promise<unknown>) {
  Object.assign(window, { platform: { openExternal } });
}

afterEach(() => {
  Reflect.deleteProperty(window, 'platform');
});

describe('openExternalLink', () => {
  it('leaves the native anchor navigation alone without a desktop bridge', async () => {
    const { event, preventDefault } = clickEvent();

    await expect(openExternalLink(event, LINK)).resolves.toBeUndefined();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('routes through the bridge and resolves undefined when the link opened', async () => {
    const openExternal = vi.fn(async () => ({ ok: true }));
    installOpenExternal(openExternal);
    const { event, preventDefault } = clickEvent();

    await expect(openExternalLink(event, LINK)).resolves.toBeUndefined();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith(LINK);
  });

  it('resolves the bridge refusal message', async () => {
    installOpenExternal(vi.fn(async () => ({ error: 'Blocked protocol: file:', ok: false })));

    await expect(openExternalLink(clickEvent().event, LINK)).resolves.toBe(
      'Blocked protocol: file:'
    );
  });

  it('names an unexplained refusal instead of dropping it', async () => {
    installOpenExternal(vi.fn(async () => ({ ok: false })));

    await expect(openExternalLink(clickEvent().event, LINK)).resolves.toBe(
      'The link could not be opened.'
    );
  });

  it('resolves the message of a rejected bridge call', async () => {
    installOpenExternal(vi.fn(async () => Promise.reject(new Error('IPC channel closed'))));

    await expect(openExternalLink(clickEvent().event, LINK)).resolves.toBe('IPC channel closed');
  });
});
