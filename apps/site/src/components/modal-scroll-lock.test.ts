import { describe, expect, it, vi } from 'vitest';
import { isDocumentScrollLocked, lockDocumentScroll } from './modal-scroll-lock';

describe('lockDocumentScroll', () => {
  it('freezes at the measured offset and restores every inline style exactly once', () => {
    const body = {
      style: {
        left: '1px',
        overflow: 'auto',
        position: 'relative',
        right: '2px',
        top: '3px',
        width: '90%',
      },
    };
    const viewport = {
      scrollTo: vi.fn(),
      scrollX: 7,
      scrollY: 911,
    };

    const lock = lockDocumentScroll(body, viewport);

    expect(body.style).toEqual({
      left: '-7px',
      overflow: 'hidden',
      position: 'fixed',
      right: '0',
      top: '-911px',
      width: '100%',
    });

    lock.release();
    lock.release();

    expect(body.style).toEqual({
      left: '1px',
      overflow: 'auto',
      position: 'relative',
      right: '2px',
      top: '3px',
      width: '90%',
    });
    expect(viewport.scrollTo).toHaveBeenCalledOnce();
    expect(viewport.scrollTo).toHaveBeenCalledWith({ behavior: 'instant', left: 7, top: 911 });
  });

  it('reports the lock state so section navigation can bail while engaged', () => {
    const body = {
      style: { left: '', overflow: '', position: '', right: '', top: '', width: '' },
    };
    const viewport = { scrollTo: vi.fn(), scrollX: 0, scrollY: 0 };

    expect(isDocumentScrollLocked()).toBe(false);
    const lock = lockDocumentScroll(body, viewport);
    expect(isDocumentScrollLocked()).toBe(true);
    lock.release();
    expect(isDocumentScrollLocked()).toBe(false);
    // Double release must not underflow the shared counter.
    lock.release();
    expect(isDocumentScrollLocked()).toBe(false);
  });
});
