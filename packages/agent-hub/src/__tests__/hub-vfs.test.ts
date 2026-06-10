import { describe, expect, it } from 'vitest';
import { AgentHubError, createAgentHub } from '../agent-hub';

const makeHub = () => createAgentHub({ now: () => 1000 });

describe('virtual file system', () => {
  it('lists channel logs, agent profiles, and shared artifacts', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'alpha', sessionKey: 's1' });
    hub.vfsWrite({ content: '# Plan\nrefactor auth', name: 'plan.md', sessionKey: 's1' });
    const paths = hub.vfsList().map((entry) => entry.path);
    expect(paths).toContain('/channels/#general.md');
    expect(paths).toContain('/agents/brainstrike/profile.md');
    expect(paths).toContain('/agents/alpha/profile.md');
    expect(paths).toContain('/agents/alpha/shared/plan.md');
  });

  it('vfsWrite stores token-counted artifacts in the caller namespace only', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'alpha', sessionKey: 's1' });
    const entry = hub.vfsWrite({ content: 'x'.repeat(40), name: 'notes.md', sessionKey: 's1' });
    expect(entry.path).toBe('/agents/alpha/shared/notes.md');
    expect(entry.tokenCount).toBe(10);
    expect(() => hub.vfsWrite({ content: 'x', name: '../escape.md', sessionKey: 's1' })).toThrow(
      AgentHubError
    );
    expect(() => hub.vfsWrite({ content: 'x', name: 'a.md', sessionKey: 'ghost' })).toThrow(
      /register/i
    );
  });

  it('reads an artifact fully when within budget', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'alpha', sessionKey: 's1' });
    hub.vfsWrite({ content: 'hello world', name: 'a.md', sessionKey: 's1' });
    const result = hub.vfsRead({ path: '/agents/alpha/shared/a.md', sessionKey: 's1' });
    expect(result.content).toBe('hello world');
    expect(result.truncated).toBe(false);
    expect(result.nextOffsetTokens).toBeNull();
  });

  it('token-budgeted reads truncate and support offset continuation', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'alpha', sessionKey: 's1' });
    hub.vfsWrite({ content: 'a'.repeat(80), name: 'big.md', sessionKey: 's1' }); // 20 tokens
    const first = hub.vfsRead({
      maxTokens: 8,
      path: '/agents/alpha/shared/big.md',
      sessionKey: 's1',
    });
    expect(first.truncated).toBe(true);
    expect(first.content.length).toBe(32); // 8 tokens * 4 chars
    expect(first.totalTokens).toBe(20);
    expect(first.nextOffsetTokens).toBe(8);
    const second = hub.vfsRead({
      maxTokens: 100,
      offsetTokens: first.nextOffsetTokens ?? 0,
      path: '/agents/alpha/shared/big.md',
      sessionKey: 's1',
    });
    expect(second.content.length).toBe(48);
    expect(second.truncated).toBe(false);
    expect(first.content + second.content).toBe('a'.repeat(80));
  });

  it('renders profile and channel views from live hub state', () => {
    const hub = makeHub();
    hub.registerAgent({
      name: 'alpha',
      program: 'claude-code',
      sessionKey: 's1',
      worktree: '/tmp/wt',
    });
    hub.postMessage({ sessionKey: 's1', text: 'first post' });
    const profile = hub.vfsRead({ path: '/agents/alpha/profile.md', sessionKey: 's1' });
    expect(profile.content).toContain('alpha');
    expect(profile.content).toContain('claude-code');
    expect(profile.content).toContain('/tmp/wt');
    const log = hub.vfsRead({ path: '/channels/#general.md', sessionKey: 's1' });
    expect(log.content).toContain('alpha: first post');
  });

  it('throws a helpful error for unknown paths and counts reader tokens', () => {
    const hub = makeHub();
    hub.registerAgent({ name: 'alpha', sessionKey: 's1' });
    expect(() => hub.vfsRead({ path: '/nope.md', sessionKey: 's1' })).toThrow(/vfs_list/);
    hub.vfsWrite({ content: 'x'.repeat(40), name: 'a.md', sessionKey: 's1' });
    hub.registerAgent({ name: 'beta', sessionKey: 's2' });
    hub.vfsRead({ path: '/agents/alpha/shared/a.md', sessionKey: 's2' });
    expect(hub.listAgents().find((agent) => agent.name === 'beta')?.tokensReceived).toBe(10);
  });
});
