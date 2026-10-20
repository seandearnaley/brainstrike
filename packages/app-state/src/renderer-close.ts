/**
 * Terminal app-owned shutdown: producers settle before their durable owners retire.
 * This is not a cancellable window-close or navigation guard. Main's existing
 * shutdown policy ends this renderer lifetime on success, failure or deadline.
 */
type ClosePhase = 'producers' | 'persistence';
const preparations = new Map<
  () => Promise<void>,
  { phase: ClosePhase; begin: (() => void) | undefined }
>();
let preparing: Promise<void> | undefined;

export function hasRendererClosePreparationStarted(): boolean {
  return preparing !== undefined;
}

export function registerRendererClosePreparation(
  prepare: () => Promise<void>,
  phase: ClosePhase = 'producers',
  begin?: () => void
): () => void {
  if (preparing) {
    throw new Error('The renderer is already preparing to close');
  }
  preparations.set(prepare, { begin, phase });
  return () => preparations.delete(prepare);
}

/** Enroll both phases before the resource starts any asynchronous work. */
export function registerRendererCloseOwner(owner: {
  readonly begin: () => void;
  readonly prepareProducers: () => Promise<void>;
  readonly preparePersistence: () => Promise<void>;
}): () => void {
  if (preparing) {
    throw new Error('The renderer is already preparing to close');
  }
  const producers = () => owner.prepareProducers();
  const persistence = () => owner.preparePersistence();
  preparations.set(producers, { begin: undefined, phase: 'producers' });
  preparations.set(persistence, { begin: owner.begin, phase: 'persistence' });
  return () => {
    preparations.delete(producers);
    preparations.delete(persistence);
  };
}

export function prepareRendererClose(
  observe?: (phase: ClosePhase, settlement: 'begin' | 'end' | 'failure') => void
): Promise<void> {
  if (preparing) {
    return preparing;
  }
  const completion = Promise.withResolvers<void>();
  preparing = completion.promise;
  const failures: unknown[] = [];
  // Observe failures at close entry without fencing writes from admitted producers.
  for (const { begin } of preparations.values()) {
    try {
      begin?.();
    } catch (error) {
      failures.push(error);
    }
  }
  void (async () => {
    for (const phase of ['producers', 'persistence'] as const) {
      observe?.(phase, 'begin');
      const results = await Promise.allSettled(
        [...preparations]
          .filter(([, owner]) => owner.phase === phase)
          .map(async ([prepare]) => await prepare())
      );
      observe?.(phase, results.some((result) => result.status === 'rejected') ? 'failure' : 'end');
      failures.push(
        ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
      );
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Renderer producers failed to prepare for close');
    }
  })().then(completion.resolve, completion.reject);
  return preparing;
}
