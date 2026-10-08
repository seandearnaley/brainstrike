import { Memory } from '@mastra/memory';

export type NativeObservationInput = Parameters<Memory['indexObservation']>[0];

/** Ephemeral enclosure implemented by the borrowed observation-vector bridge. */
export interface StateStoreObservationPreparation {
  withPreparedObservation(
    observation: NativeObservationInput,
    index: () => Promise<void>
  ): Promise<void>;
}

/** Calls the supported public primitive only inside its committed preparation. */
export class StateStoreObservationMemory extends Memory {
  constructor(
    native: NonNullable<ConstructorParameters<typeof Memory>[0]>,
    private readonly observations: StateStoreObservationPreparation
  ) {
    if (!(native.vector && native.embedder) || typeof native.embedder === 'string') {
      throw new Error('Observation indexing requires the borrowed vector and concrete embedder');
    }
    super(native);
  }

  override indexObservation(observation: NativeObservationInput): Promise<void> {
    const captured = structuredClone(observation);
    return this.observations.withPreparedObservation(captured, () =>
      super.indexObservation(captured)
    );
  }
}

class NativeObservationChunks extends Memory {
  constructor() {
    super({ options: { observationalMemory: false, semanticRecall: false } });
  }

  chunks(text: string): readonly string[] {
    return super.chunkText(text);
  }
}

/** Trusted producer callback: exact pinned native chunks, without inference/storage.
 * https://github.com/mastra-ai/mastra/blob/@mastra/memory@1.32.1/packages/memory/src/index.ts
 */
export function chunkStateObservationText(text: string): readonly string[] {
  return new NativeObservationChunks().chunks(text);
}
