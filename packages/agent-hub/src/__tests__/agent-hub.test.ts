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

describe('messaging', () => {
  it('posts to #general by default with heuristic token count and monotonic ids', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'a', sessionKey: 's1' });
    const message = hub.postMessage({ sessionKey: 's1', text: 'x'.repeat(20) });
    expect(message.channel).toBe('#general');
    expect(message.tokenCount).toBe(5);
    expect(message.id).toBe(1);
    expect(message.fromName).toBe('a');
    const second = hub.postMessage({ sessionKey: 's1', text: 'hello' });
    expect(second.id).toBe(2);
  });

  it('rejects empty text and unregistered senders', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'a', sessionKey: 's1' });
    expect(() => hub.postMessage({ sessionKey: 's1', text: '   ' })).toThrow(AgentHubError);
    expect(() => hub.postMessage({ sessionKey: 'ghost', text: 'hi' })).toThrow(/register/i);
  });

  it('creates channels on demand and lists them', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'a', sessionKey: 's1' });
    expect(hub.listChannels()).toEqual(['#general']);
    hub.postMessage({ channel: '#dev', sessionKey: 's1', text: 'hi' });
    expect(hub.listChannels()).toEqual(['#general', '#dev']);
  });

  it('evicts oldest messages beyond maxMessagesPerChannel', () => {
    const hub = createAgentHub({ maxMessagesPerChannel: 2, now: () => 1000 });
    hub.registerAgent({ name: 'a', sessionKey: 's1' });
    hub.postMessage({ sessionKey: 's1', text: 'one' });
    hub.postMessage({ sessionKey: 's1', text: 'two' });
    hub.postMessage({ sessionKey: 's1', text: 'three' });
    const result = hub.readMessages({ sessionKey: 's1' });
    expect(result.messages.map((message) => message.text)).toEqual(['two', 'three']);
  });
});

describe('readMessages token budget', () => {
  it('returns newest messages fitting maxTokens in chronological order', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'a', sessionKey: 's1' });
    // 20 chars => 5 tokens each
    hub.postMessage({ sessionKey: 's1', text: 'a'.repeat(20) });
    hub.postMessage({ sessionKey: 's1', text: 'b'.repeat(20) });
    hub.postMessage({ sessionKey: 's1', text: 'c'.repeat(20) });
    const result = hub.readMessages({ maxTokens: 10, sessionKey: 's1' });
    expect(result.messages.map((message) => message.text[0])).toEqual(['b', 'c']);
    expect(result.tokensUsed).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.latestId).toBe(3);
  });

  it('sinceId returns only newer messages and is not truncated when all fit', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'a', sessionKey: 's1' });
    hub.postMessage({ sessionKey: 's1', text: 'first' });
    const second = hub.postMessage({ sessionKey: 's1', text: 'second' });
    const result = hub.readMessages({ sessionKey: 's1', sinceId: 1 });
    expect(result.messages.map((message) => message.id)).toEqual([second.id]);
    expect(result.truncated).toBe(false);
    expect(result.latestId).toBe(second.id);
  });

  it('reading an unknown channel returns an empty result with latestId 0', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'a', sessionKey: 's1' });
    const result = hub.readMessages({ channel: '#nope', sessionKey: 's1' });
    expect(result.messages).toEqual([]);
    expect(result.latestId).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('accumulates tokensSent on poster and tokensReceived on reader', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'poster', sessionKey: 's1' });
    hub.registerAgent({ name: 'reader', sessionKey: 's2' });
    hub.postMessage({ sessionKey: 's1', text: 'x'.repeat(40) }); // 10 tokens
    hub.readMessages({ sessionKey: 's2' });
    const roster = hub.listAgents();
    expect(roster.find((agent) => agent.name === 'poster')?.tokensSent).toBe(10);
    expect(roster.find((agent) => agent.name === 'reader')?.tokensReceived).toBe(10);
  });

  it('events fire for join, message, and leave with unsubscribe support', () => {
    const hub = makeHub();
    const joined: string[] = [];
    const left: string[] = [];
    const posted: string[] = [];
    const offJoined = hub.on('agent-joined', (agent) => joined.push(agent.name));
    hub.on('agent-left', (agent) => left.push(agent.name));
    hub.on('message-posted', (message) => posted.push(message.text));

    hub.registerAgent({ name: 'a', sessionKey: 's1' });
    hub.postMessage({ sessionKey: 's1', text: 'hello' });
    hub.disconnectAgent('s1');
    offJoined();
    hub.registerAgent({ name: 'b', sessionKey: 's2' });

    expect(joined).toEqual(['a']);
    expect(posted).toEqual(['hello']);
    expect(left).toEqual(['a']);
  });

  it('getSnapshot returns a serializable dashboard view', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'a', sessionKey: 's1' });
    hub.postMessage({ sessionKey: 's1', text: 'x'.repeat(20) });
    hub.postMessage({ channel: '#dev', sessionKey: 's1', text: 'y'.repeat(40) });
    const snapshot = hub.getSnapshot();
    expect(snapshot.agents).toHaveLength(2);
    expect(snapshot.channels).toEqual(['#general', '#dev']);
    expect(snapshot.totalMessages).toBe(2);
    expect(snapshot.totalTokens).toBe(15);
    expect(snapshot.recentMessages.map((message) => message.id)).toEqual([1, 2]);
    expect(structuredClone(snapshot)).toEqual(snapshot);
  });

  it('limit caps the number of returned messages from the newest end', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'a', sessionKey: 's1' });
    hub.postMessage({ sessionKey: 's1', text: 'one' });
    hub.postMessage({ sessionKey: 's1', text: 'two' });
    hub.postMessage({ sessionKey: 's1', text: 'three' });
    const result = hub.readMessages({ limit: 2, sessionKey: 's1' });
    expect(result.messages.map((message) => message.text)).toEqual(['two', 'three']);
    expect(result.truncated).toBe(true);
  });
});
