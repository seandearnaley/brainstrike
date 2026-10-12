// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { closePackagedDesktop } from '../../e2e/utils/packaged-electron';

it('joins a retained clean child after Playwright has disposed its application', async () => {
  const close = vi.fn(async () => {
    throw new Error('Disposed Playwright channel');
  });
  await closePackagedDesktop({
    app: { close },
    exited: Promise.resolve(),
    process: { exitCode: 0, signalCode: null },
  });
  expect(close).not.toHaveBeenCalled();
});

it('keeps the physical exit join after application close resolves', async () => {
  const exited = Promise.withResolvers<void>();
  const process = { exitCode: null as number | null, signalCode: null };
  const close = vi.fn(async () => undefined);
  let joined = false;
  const closing = closePackagedDesktop({ app: { close }, exited: exited.promise, process }).then(
    () => {
      joined = true;
    }
  );
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
  expect(joined).toBe(false);
  process.exitCode = 0;
  exited.resolve();
  await closing;
  expect(joined).toBe(true);
});

it('retains the actual failed exit instead of querying a disposed application', async () => {
  const close = vi.fn(async () => undefined);
  await expect(
    closePackagedDesktop({
      app: { close },
      exited: Promise.resolve(),
      process: { exitCode: 1, signalCode: null },
    })
  ).rejects.toThrow('code=1, signal=null');
  expect(close).not.toHaveBeenCalled();
});
