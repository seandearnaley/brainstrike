import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import type { EmbeddingHostManager } from './embedding-host-manager';
import { nativeIndexFailureRefusal } from './native-index-lifecycle';
import type { NativeIndexLifecycle } from './native-index-lifecycle-owner';

/**
 * Retry indexing (BST-2104): the person's explicit remedy for an embedding host that stopped
 * responding. The host's own owner restarts it, then the failed generation re-opens its own
 * settings, which admits the pending indexing work again. Nothing calls this automatically; a host
 * that hangs again fails the next generation with the same cause and remedy.
 */
export function createNativeIndexRetry(dependencies: {
  readonly embedding: Pick<EmbeddingHostManager, 'destroyAndRestart'>;
  readonly lifecycle: Promise<Pick<NativeIndexLifecycle, 'dispatch' | 'state'>>;
}): () => Promise<void> {
  return async () => {
    const lifecycle = await dependencies.lifecycle;
    const state = await lifecycle.state();
    // Only this cause's remedy is a restart; `rebuild-required` keeps its own (BST-1878).
    if (
      !(
        state.kind === 'failed' &&
        nativeIndexFailureRefusal(state.cause).kind === 'embedding-host-unresponsive'
      )
    ) {
      throw refusalError(
        'conflict',
        'native-index.retry-not-needed',
        'Indexing is not waiting for the embedding model to restart.'
      );
    }
    await dependencies.embedding.destroyAndRestart();
    // Generation-guarded: a save or close that superseded this failure keeps its own state.
    await lifecycle.dispatch({ generation: state.generation, kind: 'reopen' });
  };
}
