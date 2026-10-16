import type { NativeIndexLifecycleObservation } from '@brainstrike/indexing-contract/indexer-client';
import {
  type NativeIndexSettings,
  nativeIndexConfigurationIdentity,
} from './native-index-settings';

/**
 * Why a generation closed for good, or (root-data deletion) until `resume`: only
 * profile retirement releases the agent-host profile (BST-2001).
 */
export type NativeIndexCloseReason =
  | 'profile-retired'
  | 'reset'
  | 'root-data-deletion'
  | 'shutdown'
  | 'host-released';

/** An automatic re-open scheduled after a transient startup failure: which, of how many. */
export interface NativeIndexReopen {
  readonly attempt: number;
  readonly attempts: number;
}

/**
 * Why the native index is not serving, as a value the renderer and the agent
 * read (BST-1988 lifecycle). A transition is a cause, never a failure.
 */
export type NativeIndexCause =
  /** Saved settings are missing or incomplete; the message names the setup step. */
  | { readonly kind: 'setup-required'; readonly message: string; readonly error?: unknown }
  /** Saved settings cannot be read; the message is the decode error. */
  | { readonly kind: 'settings-invalid'; readonly message: string; readonly error?: unknown }
  /** A generation is opening or replacing the previous one. */
  | { readonly kind: 'transitioning' }
  /** A generation's sources failed: a scan, a watch, or startup. */
  | {
      readonly kind: 'source-failure';
      readonly message: string;
      readonly error?: unknown;
      readonly recovery?: 'sources';
      /** Set while an automatic re-open of these settings is scheduled. */
      readonly reopen?: NativeIndexReopen;
    }
  /** The index was closed for good: shutdown, reset, or profile retirement. */
  | { readonly kind: 'closed'; readonly reason: NativeIndexCloseReason };

export type NativeIndexSettingsCause = Extract<
  NativeIndexCause,
  { readonly kind: 'setup-required' | 'settings-invalid' }
>;

/** The one lifecycle value. Each generation is one writer, its sources and its leases. */
export type NativeIndexState =
  | { readonly kind: 'idle'; readonly generation: number }
  | { readonly kind: 'resuming'; readonly generation: number }
  | {
      readonly kind: 'validating';
      readonly generation: number;
      readonly previous: NativeIndexState;
    }
  | {
      readonly kind: 'unconfigured';
      readonly cause: NativeIndexSettingsCause;
      readonly generation: number;
    }
  | {
      readonly kind: 'opening';
      readonly generation: number;
      readonly settings: NativeIndexSettings;
    }
  | {
      readonly kind: 'transitioning';
      readonly from: number;
      readonly generation: number;
      readonly settings: NativeIndexSettings;
    }
  | { readonly kind: 'ready'; readonly generation: number; readonly settings: NativeIndexSettings }
  | {
      readonly kind: 'pausing';
      readonly generation: number;
      readonly settings: NativeIndexSettings;
      readonly requested: NativeIndexSettings;
    }
  | {
      readonly kind: 'failed';
      readonly cause: Extract<NativeIndexCause, { readonly kind: 'source-failure' }>;
      readonly generation: number;
      readonly settings: NativeIndexSettings;
    }
  | {
      readonly kind: 'closed';
      readonly generation: number;
      readonly reason: NativeIndexCloseReason;
      readonly cause?: unknown;
      readonly retirement: 'pending' | 'sources-stopped' | 'complete';
    };

/** Everything that can happen to the index. */
export type NativeIndexEvent =
  | { readonly kind: 'profile-resume' }
  | { readonly kind: 'profile-resumed'; readonly generation: number }
  | { readonly kind: 'rebuild-settings'; readonly settings: NativeIndexSettings }
  | { readonly kind: 'fence'; readonly reason: NativeIndexCloseReason }
  | { readonly kind: 'stop-sources'; readonly reason: NativeIndexCloseReason }
  | { readonly kind: 'sources-stopped'; readonly generation: number }
  | { readonly kind: 'settings-reading' }
  | { readonly kind: 'settings-unchanged' }
  /** The saved settings key was written; `settings` is what it now reads. */
  | { readonly kind: 'settings-saved'; readonly settings: NativeIndexSettings }
  /** The saved settings key could not be read as settings. */
  | { readonly kind: 'settings-unreadable'; readonly cause: NativeIndexSettingsCause }
  /** Committed workspace roots changed; every root is leased again. */
  | { readonly kind: 'roots-changed'; readonly settings: NativeIndexSettings }
  /** A generation finished opening. */
  | { readonly kind: 'opened'; readonly generation: number }
  /** A generation's sources failed. */
  | {
      readonly kind: 'failure';
      readonly generation: number;
      readonly message: string;
      readonly error?: unknown;
      readonly recovery?: 'sources';
      readonly reopen?: NativeIndexReopen;
    }
  /** Open the failed generation's own settings again: a scheduled automatic re-open. */
  | { readonly kind: 'reopen'; readonly generation: number }
  /** Rebuild the derived index from the catalog. */
  | { readonly kind: 'rebuild' }
  /** Cancel sources now, before the root-operation owner can join this save. */
  | { readonly kind: 'prepare-pause'; readonly settings: NativeIndexSettings }
  /** The caller reached its root-operation turn after physical source cancellation. */
  | { readonly kind: 'complete-pause'; readonly generation: number }
  /** Close for good: shutdown, reset, or profile retirement. */
  | { readonly kind: 'terminal'; readonly reason: NativeIndexCloseReason; readonly cause?: unknown }
  /** Every physical close action has joined successfully. */
  | { readonly kind: 'retired'; readonly generation: number }
  /** Reset finished; open again from the saved settings. */
  | { readonly kind: 'resume'; readonly settings: NativeIndexSettings };

/** IO the owner performs for a transition; the reducer never performs IO. */
export type NativeIndexAction =
  | { readonly kind: 'stop-sources' }
  /** Close the current generation (if any), then open `generation` from saved settings. */
  | { readonly kind: 'open'; readonly destroy: boolean; readonly generation: number }
  /** Pause or resume the live generation's sources; the writer and leases stay. */
  | { readonly kind: 'apply-sources'; readonly settings: NativeIndexSettings }
  /** Close the current generation without opening another. */
  | { readonly kind: 'close' }
  /** Release the agent-host profile. Only profile retirement produces it (BST-2001). */
  | { readonly kind: 'retire-profile'; readonly cause?: unknown };

export interface NativeIndexTransition {
  readonly actions: readonly NativeIndexAction[];
  /** Set when the event is refused in this state; the state is unchanged. */
  readonly refused?: NativeIndexCause;
  readonly state: NativeIndexState;
}

type LiveState = Extract<NativeIndexState, { readonly kind: 'ready' | 'failed' }>;

const unchanged = (state: NativeIndexState): NativeIndexTransition => ({ actions: [], state });

const isLive = (state: NativeIndexState): state is LiveState =>
  state.kind === 'ready' || state.kind === 'failed';

const liveSettings = (state: NativeIndexState): NativeIndexSettings | null => {
  if (state.kind === 'validating') {
    return liveSettings(state.previous);
  }
  return state.kind === 'unconfigured' ||
    state.kind === 'closed' ||
    state.kind === 'idle' ||
    state.kind === 'resuming'
    ? null
    : state.settings;
};

const sameConfiguration = (left: NativeIndexSettings, right: NativeIndexSettings): boolean =>
  nativeIndexConfigurationIdentity(left) === nativeIndexConfigurationIdentity(right);

function open(
  state: NativeIndexState,
  settings: NativeIndexSettings,
  destroy = false
): NativeIndexTransition {
  const generation = state.generation + 1;
  return {
    actions: [{ destroy, generation, kind: 'open' }],
    state: isLive(state)
      ? { from: state.generation, generation, kind: 'transitioning', settings }
      : { generation, kind: 'opening', settings },
  };
}

/** A save of settings already live changes nothing; a pause change applies in place. */
function settingsSaved(
  state: NativeIndexState,
  settings: NativeIndexSettings
): NativeIndexTransition {
  const live = liveSettings(state);
  if (
    live === null ||
    !sameConfiguration(live, settings) ||
    (state.kind === 'failed' && state.cause.recovery !== 'sources')
  ) {
    return open(state, settings);
  }
  if (live.paused !== settings.paused) {
    // An opening generation reads the saved settings when it starts its sources.
    return isLive(state)
      ? {
          actions: [{ kind: 'apply-sources', settings }],
          state: { generation: state.generation, kind: 'ready', settings },
        }
      : open(state, settings);
  }
  if (state.kind !== 'failed') {
    return unchanged(state);
  }
  return state.cause.recovery === 'sources'
    ? {
        actions: [{ kind: 'apply-sources', settings }],
        state: { generation: state.generation, kind: 'ready', settings },
      }
    : open(state, settings);
}

function rootsChanged(
  state: NativeIndexState,
  settings: NativeIndexSettings
): NativeIndexTransition {
  const live = liveSettings(state);
  // Roots changed with only a pause change still applies in place, as a save does.
  return live !== null &&
    isLive(state) &&
    sameConfiguration(live, settings) &&
    live.paused !== settings.paused
    ? settingsSaved(state, settings)
    : open(state, settings);
}

function failure(
  state: NativeIndexState,
  { error, generation, message, recovery, reopen }: Extract<NativeIndexEvent, { kind: 'failure' }>
): NativeIndexTransition {
  if (
    generation !== state.generation ||
    state.kind === 'unconfigured' ||
    state.kind === 'closed' ||
    state.kind === 'validating' ||
    state.kind === 'idle' ||
    state.kind === 'resuming'
  ) {
    return unchanged(state);
  }
  return {
    actions: [],
    state: {
      cause: {
        kind: 'source-failure',
        message,
        ...(error === undefined ? {} : { error }),
        ...(recovery ? { recovery } : {}),
        ...(reopen ? { reopen } : {}),
      },
      generation,
      kind: 'failed',
      settings: state.settings,
    },
  };
}

/** Only the generation that failed reopens; a later save or close already superseded it. */
function reopen(state: NativeIndexState, generation: number): NativeIndexTransition {
  return state.kind === 'failed' && state.generation === generation
    ? settingsSaved(state, state.settings)
    : unchanged(state);
}

function opened(state: NativeIndexState, generation: number): NativeIndexTransition {
  return (state.kind === 'opening' || state.kind === 'transitioning') &&
    state.generation === generation
    ? { actions: [], state: { generation, kind: 'ready', settings: state.settings } }
    : unchanged(state);
}

function rebuild(state: NativeIndexState): NativeIndexTransition {
  const live = liveSettings(state);
  if (live !== null) {
    return open(state, live, true);
  }
  return {
    ...unchanged(state),
    refused: state.kind === 'unconfigured' ? state.cause : { kind: 'transitioning' },
  };
}

function terminal(
  state: NativeIndexState,
  reason: NativeIndexCloseReason,
  cause?: unknown
): NativeIndexTransition {
  return {
    actions:
      reason === 'profile-retired'
        ? [{ kind: 'close' }, { kind: 'retire-profile', ...(cause === undefined ? {} : { cause }) }]
        : [{ kind: 'close' }],
    state: {
      generation: state.generation + 1,
      kind: 'closed',
      reason,
      retirement: 'pending',
      ...(cause === undefined ? {} : { cause }),
    },
  };
}

function closedTerminal(
  state: Extract<NativeIndexState, { readonly kind: 'closed' }>,
  event: Extract<NativeIndexEvent, { readonly kind: 'terminal' }>
): NativeIndexTransition {
  if (state.retirement === 'complete') {
    return event.reason === 'profile-retired' && state.reason !== 'profile-retired'
      ? terminal(state, event.reason, event.cause)
      : unchanged(state);
  }
  const reason =
    event.reason === 'profile-retired'
      ? event.reason
      : state.reason === 'profile-retired' ||
          state.reason === 'shutdown' ||
          state.reason === 'reset'
        ? state.reason
        : event.reason;
  return terminal(state, reason, event.cause === undefined ? state.cause : event.cause);
}
function closedTransition(
  state: Extract<NativeIndexState, { readonly kind: 'closed' }>,
  event: NativeIndexEvent
): NativeIndexTransition {
  switch (event.kind) {
    case 'terminal':
      return closedTerminal(state, event);
    case 'profile-resume':
      if (state.retirement === 'complete') {
        return { actions: [], state: { generation: state.generation + 1, kind: 'resuming' } };
      }
      break;
    case 'sources-stopped':
      return state.retirement === 'pending' && event.generation === state.generation
        ? { actions: [], state: { ...state, retirement: 'sources-stopped' } }
        : unchanged(state);
    case 'stop-sources':
      return state.retirement === 'complete'
        ? unchanged(state)
        : { actions: [{ kind: 'stop-sources' }], state };
    case 'retired':
      return event.generation === state.generation
        ? { actions: [], state: { ...state, retirement: 'complete' } }
        : unchanged(state);
    case 'resume':
      if (state.retirement === 'complete') {
        return open(state, event.settings);
      }
      break;
    case 'fence':
    case 'opened':
    case 'failure':
    case 'reopen':
      return unchanged(state);
    default:
      break;
  }
  return { actions: [], refused: { kind: 'closed', reason: state.reason }, state };
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled native index lifecycle value: ${JSON.stringify(value)}`);
}

/** The one pure, total transition function. */
export function reduceNativeIndex(
  state: NativeIndexState,
  event: NativeIndexEvent
): NativeIndexTransition {
  if (state.kind === 'closed') {
    return closedTransition(state, event);
  }
  if (
    state.kind === 'validating' &&
    event.kind !== 'terminal' &&
    event.kind !== 'fence' &&
    event.kind !== 'stop-sources'
  ) {
    return event.kind === 'settings-reading'
      ? unchanged(state)
      : reduceNativeIndex(state.previous, event);
  }
  switch (event.kind) {
    case 'profile-resumed':
      return state.kind === 'resuming' && state.generation === event.generation
        ? { actions: [], state: { generation: state.generation, kind: 'idle' } }
        : unchanged(state);
    case 'rebuild-settings':
      return open(state, event.settings, true);
    case 'profile-resume':
      return { actions: [], state: { generation: state.generation + 1, kind: 'resuming' } };
    case 'fence':
    case 'stop-sources':
      return {
        actions: event.kind === 'stop-sources' ? [{ kind: 'stop-sources' }] : [],
        state: {
          generation: state.generation + 1,
          kind: 'closed',
          reason: event.reason,
          retirement: 'pending',
        },
      };
    case 'sources-stopped':
      return unchanged(state);
    case 'settings-reading':
      return {
        actions: [],
        state: { generation: state.generation, kind: 'validating', previous: state },
      };
    case 'settings-unchanged':
      return unchanged(state);
    case 'failure':
      return failure(state, event);
    case 'reopen':
      return reopen(state, event.generation);
    case 'opened':
      return opened(state, event.generation);
    case 'prepare-pause': {
      // A failed open retains its settings, not a ready writer. Only an explicit
      // source-retirement failure can retry source cancellation in place.
      if (
        state.kind !== 'ready' &&
        state.kind !== 'pausing' &&
        !(state.kind === 'failed' && state.cause.recovery === 'sources')
      ) {
        return unchanged(state);
      }
      const paused = { ...state.settings, paused: true };
      return {
        actions: [{ kind: 'apply-sources', settings: paused }],
        state: {
          generation: state.generation,
          kind: 'pausing',
          requested: event.settings,
          settings: paused,
        },
      };
    }
    case 'complete-pause':
      return state.kind === 'pausing' && state.generation === event.generation
        ? settingsSaved(
            { generation: state.generation, kind: 'ready', settings: state.settings },
            state.requested
          )
        : { ...unchanged(state), refused: { kind: 'transitioning' } };
    case 'rebuild':
      return rebuild(state);
    case 'retired':
      return unchanged(state);
    case 'resume':
      return unchanged(state);
    case 'roots-changed':
      return rootsChanged(state, event.settings);
    case 'settings-saved':
      return settingsSaved(state, event.settings);
    case 'settings-unreadable':
      return {
        actions: state.kind === 'unconfigured' ? [] : [{ kind: 'close' }],
        state: { cause: event.cause, generation: state.generation + 1, kind: 'unconfigured' },
      };
    case 'terminal':
      return terminal(state, event.reason, event.cause);
    default:
      return assertNever(event);
  }
}

export type NativeIndexReadiness =
  | { readonly kind: 'ready'; readonly generation: number }
  | { readonly kind: 'preparing'; readonly cause: NativeIndexCause }
  | { readonly kind: 'refused'; readonly cause: NativeIndexCause };

/** What reads see: serving, preparing, or refused with a typed cause. */
export function nativeIndexReadiness(state: NativeIndexState): NativeIndexReadiness {
  switch (state.kind) {
    case 'ready':
    case 'pausing':
      return { generation: state.generation, kind: 'ready' };
    case 'idle':
    case 'resuming':
    case 'opening':
    case 'transitioning':
    case 'validating':
      return { cause: { kind: 'transitioning' }, kind: 'preparing' };
    case 'unconfigured':
    case 'failed':
      return { cause: state.cause, kind: 'refused' };
    case 'closed':
      return { cause: { kind: 'closed', reason: state.reason }, kind: 'refused' };
    default:
      return assertNever(state);
  }
}

/** Drop native error objects at the observer boundary; the cause tag remains exact. */
export function nativeIndexObservation(state: NativeIndexState): NativeIndexLifecycleObservation {
  const readiness = nativeIndexReadiness(state);
  if (readiness.kind === 'ready') {
    return readiness;
  }
  const cause = readiness.cause;
  return {
    cause:
      cause.kind === 'transitioning'
        ? { kind: cause.kind }
        : cause.kind === 'closed'
          ? { kind: cause.kind, reason: cause.reason }
          : { kind: cause.kind, message: describeCause(cause) },
    generation: state.generation,
    kind: readiness.kind,
  };
}

function describeCause(
  cause: Exclude<NativeIndexCause, { readonly kind: 'transitioning' | 'closed' }>
): string {
  const reopen = cause.kind === 'source-failure' ? cause.reopen : undefined;
  return reopen
    ? `${cause.message} Retrying automatically (attempt ${reopen.attempt} of ${reopen.attempts}).`
    : cause.message;
}
