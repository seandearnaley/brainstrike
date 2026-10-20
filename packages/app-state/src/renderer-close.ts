/**
 * Terminal app-owned shutdown: producers settle before their durable owners retire.
 * This is not a cancellable window-close or navigation guard. Main's existing
 * shutdown policy ends this renderer lifetime on success, failure or deadline.
 */
const preparations = new Set<() => Promise<void>>();
let preparing: Promise<void> | undefined;

export function hasRendererClosePreparationStarted(): boolean {
  return preparing !== undefined;
}

export function registerRendererClosePreparation(prepare: () => Promise<void>): () => void {
  if (preparing) {
    throw new Error('The renderer is already preparing to close');
  }
  preparations.add(prepare);
  return () => preparations.delete(prepare);
}

export function prepareRendererClose(): Promise<void> {
  preparing ??= Promise.resolve().then(async () => {
    const results = await Promise.allSettled(
      [...preparations].map(async (prepare) => await prepare())
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Renderer producers failed to prepare for close');
    }
  });
  return preparing;
}
