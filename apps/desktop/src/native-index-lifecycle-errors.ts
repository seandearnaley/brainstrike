import { NativeIndexRefusalError } from '@brainstrike/assistant-service/node-native-text-services';
import { NativeAuthorityTransitionError as TransitionError } from './native-authority-transition';
import type { NativeIndexState } from './native-index-lifecycle';

export function nativeIndexStateError(state: NativeIndexState): Error {
  if (state.kind === 'failed' && state.cause.blockedReason !== undefined) {
    // A failure only Retry indexing recovers stays that typed refusal, even when retirement also
    // failed; the full failure rides as its cause.
    return new NativeIndexRefusalError(
      {
        blockedReason: state.cause.blockedReason,
        kind: 'source-failure',
        message: state.cause.message,
      },
      state.cause.message,
      { cause: state.cause.error }
    );
  }
  if (state.kind === 'failed' || state.kind === 'unconfigured') {
    // An independent cleanup failure remains a failure of that exact operation.
    if (
      state.cause.error instanceof AggregateError ||
      state.cause.error instanceof NativeIndexRefusalError
    ) {
      return state.cause.error;
    }
    return new NativeIndexRefusalError(
      { kind: state.cause.kind, message: state.cause.message },
      state.cause.message,
      { cause: state.cause.error }
    );
  }
  if (state.kind === 'closed') {
    return new NativeIndexRefusalError(
      { kind: 'closed', reason: state.reason },
      'Native index activation is closed for terminal retirement.',
      { cause: state.cause }
    );
  }
  return new TransitionError(
    state.kind === 'validating'
      ? 'Native saved configuration is being revalidated.'
      : 'Native index is transitioning.'
  );
}
