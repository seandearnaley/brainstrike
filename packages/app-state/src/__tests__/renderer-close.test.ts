import { beforeEach, describe, expect, it, vi } from 'vitest';

let rendererClose: typeof import('../renderer-close.ts');

describe('document unload flush registry', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.inert = false;
    rendererClose = await import('../renderer-close.ts');
  });

  it('fences the UI, then joins every durable flush', async () => {
    const order: string[] = [];
    const held = Promise.withResolvers<void>();
    rendererClose.registerDurableFlush(async () => {
      order.push(`flush while inert=${document.body.inert}`);
      await held.promise;
      order.push('acknowledged');
    });
    let prepared = false;
    const preparing = rendererClose.prepareRendererClose().then(() => {
      prepared = true;
    });
    await vi.waitFor(() => expect(order).toEqual(['flush while inert=true']));
    expect(prepared).toBe(false);

    held.resolve();
    await preparing;
    expect(order).toEqual(['flush while inert=true', 'acknowledged']);
  });

  it('runs every flush even when one fails, then reports each failure', async () => {
    const failure = new Error('owner refused the write');
    const second = vi.fn(async () => undefined);
    rendererClose.registerDurableFlush(() => Promise.reject(failure));
    rendererClose.registerDurableFlush(second);

    await expect(rendererClose.prepareRendererClose()).rejects.toMatchObject({
      errors: [failure],
    });
    expect(second).toHaveBeenCalledOnce();
  });

  it('latches this document: a second request joins the same preparation and late writers are refused', async () => {
    const flush = vi.fn(async () => undefined);
    rendererClose.registerDurableFlush(flush);

    const first = rendererClose.prepareRendererClose();
    expect(rendererClose.prepareRendererClose()).toBe(first);
    await first;

    expect(flush).toHaveBeenCalledOnce();
    expect(rendererClose.hasRendererClosePreparationStarted()).toBe(true);
    expect(() => rendererClose.registerDurableFlush(flush)).toThrow(
      'The document is already preparing to unload'
    );
  });
});
