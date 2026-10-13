import { describe, expect, it } from 'vitest';
import {
  type NativeIndexEvent,
  type NativeIndexState,
  nativeIndexReadiness,
  reduceNativeIndex,
} from '../native-index-lifecycle';
import { readNativeIndexSettings } from '../native-index-settings';

// Recorded from Main's storage reads while the desktop app chose Text search,
// then Text and semantic search with WASM · Q8 (BST-1988).
const TEXT = readNativeIndexSettings(
  '{"state":{"enabled":true,"indexingPolicyPreset":"balanced","managedCollectionId":null,"mode":"root-folder-cache","nativeIndexMode":"TEXT","nativeLocalSelection":null,"paused":false,"worktreeRootIndexingOptInById":{}},"version":6}'
);
const VECTOR_JSON =
  '{"state":{"enabled":true,"indexingPolicyPreset":"balanced","managedCollectionId":"3a48f02c-2c2a-4835-926d-59cbc286513a","mode":"root-folder-cache","nativeIndexMode":"VECTOR","nativeLocalSelection":{"device":"wasm","dimensions":384,"dtype":"q8","modelId":"Xenova/bge-small-en-v1.5"},"paused":false,"worktreeRootIndexingOptInById":{}},"version":6}';
const VECTOR = readNativeIndexSettings(VECTOR_JSON);
const VECTOR_PAUSED = readNativeIndexSettings(
  VECTOR_JSON.replace('"paused":false', '"paused":true')
);
const SETUP = {
  kind: 'setup-required',
  message: 'Choose a search mode in Search & Indexing settings.',
} as const;

const ready: NativeIndexState = { generation: 3, kind: 'ready', settings: VECTOR };
const failed: NativeIndexState = {
  cause: { kind: 'source-failure', message: 'Initial native workspace scan was aborted.' },
  generation: 3,
  kind: 'failed',
  settings: VECTOR,
};
const opening: NativeIndexState = { generation: 3, kind: 'opening', settings: VECTOR };
const unconfigured: NativeIndexState = { cause: SETUP, generation: 3, kind: 'unconfigured' };
const closed: NativeIndexState = { generation: 3, kind: 'closed', reason: 'shutdown' };

const saved = (settings: typeof TEXT): NativeIndexEvent => ({ kind: 'settings-saved', settings });
const openAction = (generation: number, destroy = false) => ({
  destroy,
  generation,
  kind: 'open',
});

describe('settings saves', () => {
  it('a save of the configuration already live changes nothing', () => {
    const next = reduceNativeIndex(ready, saved(VECTOR));
    expect(next.actions).toEqual([]);
    expect(next.state).toBe(ready);
  });

  it('a pause change applies to the live generation in place', () => {
    const next = reduceNativeIndex(ready, saved(VECTOR_PAUSED));
    expect(next.actions).toEqual([{ kind: 'apply-sources', settings: VECTOR_PAUSED }]);
    expect(next.state).toEqual({ generation: 3, kind: 'ready', settings: VECTOR_PAUSED });
  });

  it('a changed configuration opens the next generation, transitioning from the live one', () => {
    const next = reduceNativeIndex(ready, saved(TEXT));
    expect(next.actions).toEqual([openAction(4)]);
    expect(next.state).toEqual({ from: 3, generation: 4, kind: 'transitioning', settings: TEXT });
  });

  it('the same save after a failure opens again, so saving retries', () => {
    const next = reduceNativeIndex(failed, saved(VECTOR));
    expect(next.actions).toEqual([openAction(4)]);
    expect(next.state.kind).toBe('transitioning');
  });

  it('settings saved while unconfigured open the first generation', () => {
    const next = reduceNativeIndex(unconfigured, saved(TEXT));
    expect(next.actions).toEqual([openAction(4)]);
    expect(next.state).toEqual({ generation: 4, kind: 'opening', settings: TEXT });
  });

  it('an opening generation ignores the same save and is replaced by a changed one', () => {
    expect(reduceNativeIndex(opening, saved(VECTOR)).actions).toEqual([]);
    const changed = reduceNativeIndex(opening, saved(TEXT));
    expect(changed.actions).toEqual([openAction(4)]);
    expect(changed.state).toEqual({ generation: 4, kind: 'opening', settings: TEXT });
  });

  it('unreadable settings close the live generation and name the setup step', () => {
    const next = reduceNativeIndex(ready, { cause: SETUP, kind: 'settings-unreadable' });
    expect(next.actions).toEqual([{ kind: 'close' }]);
    expect(next.state).toEqual({ cause: SETUP, generation: 4, kind: 'unconfigured' });
    expect(
      reduceNativeIndex(unconfigured, { cause: SETUP, kind: 'settings-unreadable' }).actions
    ).toEqual([]);
  });
});

describe('roots and generations', () => {
  it('roots changed with the same settings lease every root in a new generation', () => {
    expect(reduceNativeIndex(ready, { kind: 'roots-changed', settings: VECTOR }).actions).toEqual([
      openAction(4),
    ]);
  });

  it('roots changed with only a pause change applies it in place, as a save does', () => {
    expect(
      reduceNativeIndex(ready, { kind: 'roots-changed', settings: VECTOR_PAUSED }).actions
    ).toEqual([{ kind: 'apply-sources', settings: VECTOR_PAUSED }]);
  });

  it('the opening generation becomes ready; a superseded one is ignored', () => {
    expect(reduceNativeIndex(opening, { generation: 3, kind: 'opened' }).state).toEqual(ready);
    expect(reduceNativeIndex(opening, { generation: 2, kind: 'opened' }).state).toBe(opening);
  });

  it('a failure of the current generation is its state; a superseded one is ignored', () => {
    const next = reduceNativeIndex(ready, {
      generation: 3,
      kind: 'failure',
      message: 'scan aborted',
    });
    expect(next.state).toEqual({
      cause: { kind: 'source-failure', message: 'scan aborted' },
      generation: 3,
      kind: 'failed',
      settings: VECTOR,
    });
    expect(reduceNativeIndex(ready, { generation: 2, kind: 'failure', message: 'old' }).state).toBe(
      ready
    );
  });

  it('rebuild destroys and reopens the derived index; unconfigured refuses with its setup step', () => {
    expect(reduceNativeIndex(ready, { kind: 'rebuild' }).actions).toEqual([openAction(4, true)]);
    const refused = reduceNativeIndex(unconfigured, { kind: 'rebuild' });
    expect(refused.actions).toEqual([]);
    expect(refused.refused).toEqual(SETUP);
  });
});

describe('terminal closure', () => {
  it('shutdown and reset close the generation and keep the agent-host profile', () => {
    for (const reason of ['shutdown', 'reset'] as const) {
      const next = reduceNativeIndex(ready, { kind: 'terminal', reason });
      expect(next.actions).toEqual([{ kind: 'close' }]);
      expect(next.state).toEqual({ generation: 4, kind: 'closed', reason });
    }
  });

  it('only profile retirement releases the agent-host profile (BST-2001)', () => {
    const states = [ready, failed, opening, unconfigured, closed];
    const events: NativeIndexEvent[] = [
      saved(TEXT),
      saved(VECTOR),
      { cause: SETUP, kind: 'settings-unreadable' },
      { kind: 'roots-changed', settings: VECTOR },
      { generation: 3, kind: 'opened' },
      { generation: 3, kind: 'failure', message: 'scan aborted' },
      { kind: 'rebuild' },
      { kind: 'terminal', reason: 'shutdown' },
      { kind: 'terminal', reason: 'reset' },
      { kind: 'resume', settings: VECTOR },
    ];
    for (const state of states) {
      for (const event of events) {
        expect(reduceNativeIndex(state, event).actions).not.toContainEqual({
          kind: 'retire-profile',
        });
      }
    }
    expect(
      reduceNativeIndex(ready, { kind: 'terminal', reason: 'profile-retired' }).actions
    ).toEqual([{ kind: 'close' }, { kind: 'retire-profile' }]);
  });

  it('a closed index refuses events with its cause until it resumes', () => {
    const refused = reduceNativeIndex(closed, saved(VECTOR));
    expect(refused.actions).toEqual([]);
    expect(refused.refused).toEqual({ kind: 'closed', reason: 'shutdown' });
    expect(reduceNativeIndex(closed, { kind: 'resume', settings: VECTOR })).toEqual({
      actions: [openAction(4)],
      state: { generation: 4, kind: 'opening', settings: VECTOR },
    });
  });
});

describe('read admission', () => {
  it('a transition prepares; only an unconfigured, failed or closed index refuses, with its cause', () => {
    expect(nativeIndexReadiness(ready)).toEqual({ generation: 3, kind: 'ready' });
    expect(nativeIndexReadiness(opening)).toEqual({
      cause: { kind: 'transitioning' },
      kind: 'preparing',
    });
    expect(
      nativeIndexReadiness({ from: 3, generation: 4, kind: 'transitioning', settings: TEXT })
    ).toEqual({ cause: { kind: 'transitioning' }, kind: 'preparing' });
    expect(nativeIndexReadiness(unconfigured)).toEqual({ cause: SETUP, kind: 'refused' });
    expect(nativeIndexReadiness(failed)).toEqual({
      cause: { kind: 'source-failure', message: 'Initial native workspace scan was aborted.' },
      kind: 'refused',
    });
    expect(nativeIndexReadiness(closed)).toEqual({
      cause: { kind: 'closed', reason: 'shutdown' },
      kind: 'refused',
    });
  });
});
