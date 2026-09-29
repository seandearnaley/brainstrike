import { expect, it, vi } from 'vitest';
import { createStreamAbortContext, settleStreamCleanup } from '../mastra/turn-attempts';

it('construction failure aborts the attempt but preserves durable paused children', async () => {
  const stop = vi.fn(async (_cancelPaused: boolean) => {});
  const context = createStreamAbortContext(undefined, stop);
  context.abort(new Error('Provider initialization failed'));
  await context.dispose();
  expect(context.signal.aborted).toBe(true);
  expect(stop).toHaveBeenCalledExactlyOnceWith(false);
});

it('explicit external root Stop cancels paused children and joins its failure', async () => {
  const controller = new AbortController();
  const failure = new Error('Cancellation write failed');
  const stop = vi.fn(async (_cancelPaused: boolean) => {
    throw failure;
  });
  const context = createStreamAbortContext(controller.signal, stop);
  controller.abort(new Error('User stopped root'));
  await expect(context.dispose()).rejects.toBe(failure);
  expect(stop).toHaveBeenCalledExactlyOnceWith(true);
});

it('stream cleanup joins every owner, logs diagnostics and retains the stream cause', async () => {
  const primary = new Error('Provider stream failed');
  const cleanup = new Error('Workflow cleanup failed');
  const release = Promise.withResolvers<void>();
  const diagnostics = vi.fn();
  const settled = settleStreamCleanup(
    [Promise.reject(cleanup), release.promise],
    primary,
    diagnostics
  );
  const assertion = expect(settled).rejects.toMatchObject({ errors: [primary, cleanup] });
  expect(diagnostics).not.toHaveBeenCalled();
  release.resolve();
  await assertion;
  expect(diagnostics).toHaveBeenCalledOnce();
});
