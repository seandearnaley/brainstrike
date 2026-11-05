/**
 * Subagent persona availability preferences: master delegation switch +
 * per-persona disables, persisted; the request builder emits the wire field
 * ONLY when something diverges from defaults (presence-means-non-default,
 * mirrors permissionPolicyRequest/planMode).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildSubagentPersonasAvailabilityRequest,
  getSubagentPersonasAvailabilityRequest,
  useSubagentPersonasStore,
} from '../stores/subagent-personas-store.ts';

const STORE_KEY = 'brainstrike:subagent-personas.v1';

beforeEach(() => {
  window.localStorage.clear();
});

describe('subagent-personas-store', () => {
  it('defaults: delegation on, nothing disabled', () => {
    const state = useSubagentPersonasStore.getState();
    expect(state.delegationEnabled).toBe(true);
    expect(state.disabledPersonaIds).toEqual([]);
  });

  it('setDelegationEnabled toggles and persists', () => {
    useSubagentPersonasStore.getState().setDelegationEnabled(false);
    expect(useSubagentPersonasStore.getState().delegationEnabled).toBe(false);
    const raw = window.localStorage.getItem(STORE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).state.delegationEnabled).toBe(false);
  });

  it('setPersonaEnabled(false) records the id once; (true) clears it', () => {
    const { setPersonaEnabled } = useSubagentPersonasStore.getState();
    setPersonaEnabled('explore', false);
    setPersonaEnabled('explore', false);
    expect(useSubagentPersonasStore.getState().disabledPersonaIds).toEqual(['explore']);
    setPersonaEnabled('explore', true);
    expect(useSubagentPersonasStore.getState().disabledPersonaIds).toEqual([]);
  });

  it('request builder returns undefined at defaults (field stays off the wire)', () => {
    expect(getSubagentPersonasAvailabilityRequest()).toBeUndefined();
  });

  it('request builder emits only the diverging fields', () => {
    useSubagentPersonasStore.getState().setPersonaEnabled('explore', false);
    expect(getSubagentPersonasAvailabilityRequest()).toEqual({
      disabledPersonaIds: ['explore'],
    });

    useSubagentPersonasStore.getState().setDelegationEnabled(false);
    expect(getSubagentPersonasAvailabilityRequest()).toEqual({
      delegationEnabled: false,
      disabledPersonaIds: ['explore'],
    });
  });

  it('pure builder is testable without zustand', () => {
    expect(
      buildSubagentPersonasAvailabilityRequest({
        delegationEnabled: false,
        disabledPersonaIds: [],
      })
    ).toEqual({ delegationEnabled: false });
  });

  it('self-heals a malformed persisted payload on rehydration', async () => {
    const defaults = useSubagentPersonasStore.getInitialState();
    window.localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ state: { delegationEnabled: 'nope', disabledPersonaIds: [42] }, version: 1 })
    );

    await useSubagentPersonasStore.persist.rehydrate();

    const state = useSubagentPersonasStore.getState();
    expect(state.delegationEnabled).toBe(defaults.delegationEnabled);
    expect(state.disabledPersonaIds).toEqual([]);
  });
});
