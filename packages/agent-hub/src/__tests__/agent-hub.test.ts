import { describe, expect, it } from 'vitest';
import { AgentHubError, createAgentHub } from '../agent-hub';

const makeHub = () => createAgentHub({ now: () => 1000 });

describe('agent registry', () => {
  it('registers an agent with identity, color, and roster placement', () => {
    const hub = makeHub();
    const agent = hub.registerAgent({
      name: 'claude',
      program: 'claude-code',
      sessionKey: 's1',
    });
    expect(agent.agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(agent.name).toBe('claude');
    expect(agent.color).toBe('chart-1');
    expect(agent.status).toBe('online');
    expect(agent.joinedAt).toBe(1000);
    expect(agent.builtin).toBe(false);
    expect(hub.listAgents().some((entry) => entry.agentId === agent.agentId)).toBe(true);
  });

  it('suffixes colliding names and cycles colors', () => {
    const hub = makeHub();
    const first = hub.registerAgent({ name: 'claude', sessionKey: 's1' });
    const second = hub.registerAgent({ name: 'claude', sessionKey: 's2' });
    expect(first.name).toBe('claude');
    expect(second.name).toBe('claude-2');
    expect(second.color).toBe('chart-2');
  });

  it('includes a builtin brainstrike participant that is always online', () => {
    const builtin = makeHub()
      .listAgents()
      .find((agent) => agent.builtin);
    expect(builtin?.name).toBe('brainstrike');
    expect(builtin?.status).toBe('online');
  });

  it('re-registering the same session replaces the previous identity', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'one', sessionKey: 's1' });
    hub.registerAgent({ name: 'two', sessionKey: 's1' });
    const named = hub.listAgents().filter((agent) => !agent.builtin);
    expect(named).toHaveLength(1);
    expect(named[0]?.name).toBe('two');
  });

  it('disconnect marks the agent offline and releases its session key', () => {
    const hub = makeHub();
    const agent = hub.registerAgent({ name: 'claude', sessionKey: 's1' });
    hub.disconnectAgent('s1');
    const roster = hub.listAgents();
    expect(roster.find((entry) => entry.agentId === agent.agentId)?.status).toBe('offline');
    expect(hub.getAgentBySessionKey('s1')).toBeUndefined();
  });

  it('throws AgentHubError on blank names', () => {
    const hub = makeHub();
    expect(() => hub.registerAgent({ name: '   ', sessionKey: 's1' })).toThrow(AgentHubError);
  });

  it('disconnecting an unknown session is a no-op', () => {
    const hub = makeHub();
    expect(() => hub.disconnectAgent('missing')).not.toThrow();
  });
});
