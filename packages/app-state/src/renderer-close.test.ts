import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());

it('observes held producer and persistence phases without changing their original failure', async () => {
  const close = await import('./renderer-close');
  const producer = Promise.withResolvers<void>();
  const adapter = Promise.withResolvers<void>();
  const failure = new Error('controlled producer failure');
  const phases: string[] = [];
  close.registerRendererClosePreparation(async () => await producer.promise);
  close.registerRendererClosePreparation(async () => await adapter.promise, 'persistence');
  const result = close
    .prepareRendererClose((phase, settlement) => phases.push(`${phase}-${settlement}`))
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(phases).toEqual(['producers-begin']));
  producer.reject(failure);
  await vi.waitFor(() =>
    expect(phases).toEqual(['producers-begin', 'producers-failure', 'persistence-begin'])
  );
  adapter.resolve();
  const caught = await result;
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([failure]);
  expect(phases.at(-1)).toBe('persistence-end');
});

it('paired admission observes begin before producers and retains both phases with a shared callback', async () => {
  const close = await import('./renderer-close');
  let observing = false;
  const events: string[] = [];
  const prepare = async () => {
    expect(observing).toBe(true);
    events.push('phase');
  };
  close.registerRendererCloseOwner({
    begin: () => {
      observing = true;
      events.push('begin');
    },
    preparePersistence: prepare,
    prepareProducers: prepare,
  });
  await close.prepareRendererClose();
  expect(events).toEqual(['begin', 'phase', 'phase']);
  expect(() =>
    close.registerRendererCloseOwner({
      begin: () => {},
      preparePersistence: prepare,
      prepareProducers: prepare,
    })
  ).toThrow('already preparing to close');
});

it('begins observing synchronously before an already queued rejection reaction drains', async () => {
  const { registerRendererClosePreparation: register, prepareRendererClose: prepare } =
    await import('./renderer-close');
  const save = Promise.withResolvers<void>();
  const producer = Promise.withResolvers<void>();
  const failure = new Error('pending save rejected at close entry');
  let observing = false;
  let retained: unknown;
  void save.promise.then(
    () => {},
    (error: unknown) => {
      if (observing) {
        retained = error;
      }
    }
  );
  register(async () => {
    await producer.promise;
  });
  register(
    async () => {
      if (retained) {
        throw retained;
      }
    },
    'persistence',
    () => {
      observing = true;
    }
  );
  save.reject(failure);
  const closing = prepare();
  producer.resolve();
  const result = await closing.catch((error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect((result as AggregateError).errors).toEqual([failure]);
});

it('settles admitted producers before persistence, then joins its original adapter ACK', async () => {
  const { registerRendererClosePreparation: register, prepareRendererClose: prepare } =
    await import('./renderer-close');
  const hydration = Promise.withResolvers<void>();
  const ack = Promise.withResolvers<void>();
  const events: string[] = [];
  register(async () => {
    events.push('producer');
    await hydration.promise;
    events.push('hydrated');
  });
  register(
    async () => {
      events.push('persistence');
      await ack.promise;
      events.push('ack');
    },
    'persistence',
    () => {
      events.push('observe');
    }
  );
  let done = false;
  const closing = prepare().then(() => {
    done = true;
  });
  await vi.waitFor(() => expect(events).toContain('producer'));
  expect(events).toEqual(['observe', 'producer']);
  hydration.resolve();
  await vi.waitFor(() => expect(events).toContain('persistence'));
  expect(events).toEqual(['observe', 'producer', 'hydrated', 'persistence']);
  expect(done).toBe(false);
  ack.resolve();
  await closing;
  expect(events.at(-1)).toBe('ack');
});

it('attempts storage drain after producer failure and preserves each original cause', async () => {
  const { registerRendererClosePreparation: register, prepareRendererClose: prepare } =
    await import('./renderer-close');
  const producerFailure = new Error('producer failed');
  const writeFailure = new Error('adapter failed');
  const events: string[] = [];
  register(async () => {
    events.push('producer');
    throw producerFailure;
  });
  register(async () => {
    events.push('persistence');
    throw writeFailure;
  }, 'persistence');
  const failure = await prepare().catch((error: unknown) => error);
  expect(events).toEqual(['producer', 'persistence']);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([producerFailure, writeFailure]);
});
