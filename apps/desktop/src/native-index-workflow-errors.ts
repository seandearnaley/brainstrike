import { NativeIndexRefusalError } from '@brainstrike/indexing-contract/indexer-client';
import { Data } from 'effect';
import type {
  NativeIndexAction,
  NativeIndexCause,
  NativeIndexEvent,
} from './native-index-lifecycle';

/** An event the current state refuses, with that state's cause. */
export class NativeIndexEventRefusedError extends Data.TaggedError('NativeIndexEventRefused')<{
  readonly cause: NativeIndexCause;
  readonly event: NativeIndexEvent['kind'];
}> {
  override get message(): string {
    return `Native index ${this.event} refused: ${this.cause.kind}.`;
  }
}

/** A rejected settings capability, retaining its exact public rejection value. */
export class NativeIndexSettingsFailure extends Data.TaggedError('NativeIndexSettingsFailure')<{
  readonly cause: unknown;
  readonly reason: 'setup-required' | 'settings-invalid';
}> {}

/** A rejected action capability, never a new automatic-retry classification. */
export class NativeIndexActionFailure extends Data.TaggedError('NativeIndexActionFailure')<{
  readonly action: NativeIndexAction['kind'];
  readonly cause: unknown;
  readonly recovery?: 'sources';
}> {}

export class NativeIndexObservationAborted extends Data.TaggedError(
  'NativeIndexObservationAborted'
)<{
  readonly cause: unknown;
}> {}

export type NativeIndexWorkflowFailure =
  | NativeIndexEventRefusedError
  | NativeIndexSettingsFailure
  | NativeIndexActionFailure
  | NativeIndexObservationAborted;

/** Only the existing Promise edge unwraps expected failures. Defects bypass this. */
export function nativeIndexPublicFailure(failure: NativeIndexWorkflowFailure): unknown {
  switch (failure._tag) {
    case 'NativeIndexEventRefused':
      // Refused because search is off: the same typed Off refusal a read gets, so Settings
      // shows the Off sentence instead of an internal error.
      return failure.cause.kind === 'off'
        ? new NativeIndexRefusalError(failure.cause, failure.cause.message)
        : failure;
    case 'NativeIndexSettingsFailure':
    case 'NativeIndexActionFailure':
    case 'NativeIndexObservationAborted':
      return failure.cause;
  }
}
