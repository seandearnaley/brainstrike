/** @vitest-environment jsdom */

import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadDialog } from './download-chooser';

function installDialogMethods(): void {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    }),
  });
}

afterEach(() => {
  document.body.removeAttribute('style');
  document.body.replaceChildren();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.restoreAllMocks();
});

describe('DownloadDialog', () => {
  it('retains its controller and scroll lock through the React Strict Mode ref replay', async () => {
    installDialogMethods();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <DownloadDialog manifestState={{ status: 'loading' }} onClose={vi.fn()} open />
        </StrictMode>
      );
    });

    const dialog = document.querySelector('dialog');
    expect(dialog?.open).toBe(true);
    expect(document.body.style.position).toBe('fixed');

    await act(async () => root.unmount());
    expect(document.body.style.position).toBe('');
  });
});
