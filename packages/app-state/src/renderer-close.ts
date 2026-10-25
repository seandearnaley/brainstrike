/**
 * Every unload of this document flushes its durable writers (ADR-0026 R1). Main asks before it
 * quits, closes the window or reloads it, and unloads the document after the answer, success or
 * failure. Only writers whose last write may still be buffered register: the thread workspace,
 * Explorer persistence and the panel layout. Nothing else, reads included, is joined here.
 *
 * The latch belongs to this document generation: once preparation starts this document is
 * fenced and about to be replaced or closed by Main, which owns that decision. A reloaded
 * document starts a fresh registry.
 */
const flushes = new Set<() => Promise<void>>();
let preparing: Promise<void> | undefined;

export function hasRendererClosePreparationStarted(): boolean {
  return preparing !== undefined;
}

/** Registers a durable writer's `flush()`; a writer whose tail is already gone needs none. */
export function registerDurableFlush(flush: () => Promise<void>): () => void {
  if (preparing) {
    throw new Error('The document is already preparing to unload');
  }
  flushes.add(flush);
  return () => flushes.delete(flush);
}

/** Fences the UI, then joins every durable writer's flush and reports each one that failed. */
export function prepareRendererClose(): Promise<void> {
  preparing ??= Promise.resolve().then(async () => {
    if (typeof document !== 'undefined' && document.body) {
      document.body.inert = true;
    }
    const results = await Promise.allSettled([...flushes].map(async (flush) => await flush()));
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      // Only the message crosses the context bridge to Main, so it names every cause.
      const causes = failures.map((failure) =>
        failure instanceof Error ? failure.message : String(failure)
      );
      throw new AggregateError(
        failures,
        `Durable writers failed to flush before unload: ${causes.join('; ')}`
      );
    }
  });
  return preparing;
}
