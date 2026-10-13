import {
  type NativeIndexSettings,
  nativeIndexConfigurationIdentity,
} from './native-index-settings';

export type NativeIndexCloseReason = 'profile-retired' | 'reset' | 'shutdown';

/**
 * Why the native index is not serving, as a value the renderer and the agent
 * read (BST-1988 lifecycle). A transition is a cause, never a failure.
 */
export type NativeIndexCause =
  /** Saved settings are missing or incomplete; the message names the setup step. */
  | { readonly kind: 'setup-required'; readonly message: string }
  /** Saved settings cannot be read; the message is the decode error. */
  | { readonly kind: 'settings-invalid'; readonly message: string }
  /** A generation is opening or replacing the previous one. */
  | { readonly kind: 'transitioning' }
  /** A generation's sources failed: a scan, a watch, or startup. */
  | { readonly kind: 'source-failure'; readonly message: string }
  /** The index was closed for good: shutdown, reset, or profile retirement. */
  | { readonly kind: 'closed'; readonly reason: NativeIndexCloseReason };

export type NativeIndexSettingsCause = Extract<
  NativeIndexCause,
  { readonly kind: 'setup-required' | 'settings-invalid' }
>;

/** The one lifecycle value. Each generation is one writer, its sources and its leases. */
export type NativeIndexState =
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
      readonly kind: 'failed';
      readonly cause: Extract<NativeIndexCause, { readonly kind: 'source-failure' }>;
      readonly generation: number;
      readonly settings: NativeIndexSettings;
    }
  | {
      readonly kind: 'closed';
      readonly generation: number;
      readonly reason: NativeIndexCloseReason;
    };

/** Everything that can happen to the index. */
export type NativeIndexEvent =
  /** The saved settings key was written; `settings` is what it now reads. */
  | { readonly kind: 'settings-saved'; readonly settings: NativeIndexSettings }
  /** The saved settings key could not be read as settings. */
  | { readonly kind: 'settings-unreadable'; readonly cause: NativeIndexSettingsCause }
  /** Committed workspace roots changed; every root is leased again. */
  | { readonly kind: 'roots-changed'; readonly settings: NativeIndexSettings }
  /** A generation finished opening. */
  | { readonly kind: 'opened'; readonly generation: number }
  /** A generation's sources failed. */
  | { readonly kind: 'failure'; readonly generation: number; readonly message: string }
  /** Rebuild the derived index from the catalog. */
  | { readonly kind: 'rebuild' }
  /** Close for good: shutdown, reset, or profile retirement. */
  | { readonly kind: 'terminal'; readonly reason: NativeIndexCloseReason }
  /** Reset finished; open again from the saved settings. */
  | { readonly kind: 'resume'; readonly settings: NativeIndexSettings };

/** IO the owner performs for a transition; the reducer never performs IO. */
export type NativeIndexAction =
  /** Close the current generation (if any), then open `generation` from saved settings. */
  | { readonly kind: 'open'; readonly destroy: boolean; readonly generation: number }
  /** Pause or resume the live generation's sources; the writer and leases stay. */
  | { readonly kind: 'apply-sources'; readonly settings: NativeIndexSettings }
  /** Close the current generation without opening another. */
  | { readonly kind: 'close' }
  /** Release the agent-host profile. Only profile retirement produces it (BST-2001). */
  | { readonly kind: 'retire-profile' };

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

const liveSettings = (state: NativeIndexState): NativeIndexSettings | null =>
  state.kind === 'unconfigured' || state.kind === 'closed' ? null : state.settings;

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
  if (live === null || !sameConfiguration(live, settings)) {
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
  // The same configuration: a failed generation retries; any other is already it.
  return state.kind === 'failed' ? open(state, settings) : unchanged(state);
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
  generation: number,
  message: string
): NativeIndexTransition {
  if (generation !== state.generation || state.kind === 'unconfigured' || state.kind === 'closed') {
    return unchanged(state);
  }
  return {
    actions: [],
    state: {
      cause: { kind: 'source-failure', message },
      generation,
      kind: 'failed',
      settings: state.settings,
    },
  };
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

function terminal(state: NativeIndexState, reason: NativeIndexCloseReason): NativeIndexTransition {
  return {
    actions:
      reason === 'profile-retired'
        ? [{ kind: 'close' }, { kind: 'retire-profile' }]
        : [{ kind: 'close' }],
    state: { generation: state.generation + 1, kind: 'closed', reason },
  };
}

function closedTransition(
  state: Extract<NativeIndexState, { readonly kind: 'closed' }>,
  event: NativeIndexEvent
): NativeIndexTransition {
  if (event.kind === 'resume') {
    return open(state, event.settings);
  }
  if (event.kind === 'terminal' || event.kind === 'opened' || event.kind === 'failure') {
    return unchanged(state);
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
  switch (event.kind) {
    case 'failure':
      return failure(state, event.generation, event.message);
    case 'opened':
      return opened(state, event.generation);
    case 'rebuild':
      return rebuild(state);
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
      return terminal(state, event.reason);
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
      return { generation: state.generation, kind: 'ready' };
    case 'opening':
    case 'transitioning':
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
