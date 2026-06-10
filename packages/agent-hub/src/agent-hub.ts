import { AGENT_COLOR_KEYS, BUILTIN_AGENT_COLOR, colorForIndex } from './agent-colors';
import type { AgentHub, AgentHubOptions, HubAgent, RegisterAgentInput } from './types';

export const BUILTIN_SESSION_KEY = 'builtin';
export const BUILTIN_AGENT_NAME = 'brainstrike';

export class AgentHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentHubError';
  }
}

interface HubState {
  agentsById: Map<string, HubAgent>;
  colorCursor: number;
  now: () => number;
  sessionToAgentId: Map<string, string>;
}

function uniqueName(state: HubState, requested: string): string {
  const taken = new Set([...state.agentsById.values()].map((agent) => agent.name));
  if (!taken.has(requested)) {
    return requested;
  }
  let suffix = 2;
  while (taken.has(`${requested}-${suffix}`)) {
    suffix += 1;
  }
  return `${requested}-${suffix}`;
}

function createBuiltinAgent(now: () => number): HubAgent {
  return {
    agentId: crypto.randomUUID(),
    builtin: true,
    capabilities: [],
    color: BUILTIN_AGENT_COLOR,
    joinedAt: now(),
    lastSeenAt: now(),
    name: BUILTIN_AGENT_NAME,
    sessionKey: BUILTIN_SESSION_KEY,
    status: 'online',
    tokensReceived: 0,
    tokensSent: 0,
  };
}

export function createAgentHub(options: AgentHubOptions = {}): AgentHub {
  const now = options.now ?? (() => Date.now());
  const state: HubState = {
    agentsById: new Map(),
    colorCursor: 0,
    now,
    sessionToAgentId: new Map(),
  };

  const builtin = createBuiltinAgent(now);
  state.agentsById.set(builtin.agentId, builtin);
  state.sessionToAgentId.set(BUILTIN_SESSION_KEY, builtin.agentId);

  function getAgentBySessionKey(sessionKey: string): HubAgent | undefined {
    const agentId = state.sessionToAgentId.get(sessionKey);
    return agentId === undefined ? undefined : state.agentsById.get(agentId);
  }

  function registerAgent(input: RegisterAgentInput): HubAgent {
    const requestedName = input.name.trim();
    if (requestedName.length === 0) {
      throw new AgentHubError('Agent name must not be blank.');
    }
    if (input.sessionKey === BUILTIN_SESSION_KEY) {
      throw new AgentHubError(`Session key '${BUILTIN_SESSION_KEY}' is reserved.`);
    }

    const previous = getAgentBySessionKey(input.sessionKey);
    if (previous) {
      state.agentsById.delete(previous.agentId);
      state.sessionToAgentId.delete(input.sessionKey);
    }

    const agent: HubAgent = {
      agentId: crypto.randomUUID(),
      builtin: false,
      capabilities: input.capabilities ?? [],
      color: colorForIndex(state.colorCursor),
      joinedAt: now(),
      lastSeenAt: now(),
      name: uniqueName(state, requestedName),
      sessionKey: input.sessionKey,
      status: 'online',
      tokensReceived: 0,
      tokensSent: 0,
      ...(input.program === undefined ? {} : { program: input.program }),
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
    };
    state.colorCursor = (state.colorCursor + 1) % AGENT_COLOR_KEYS.length;
    state.agentsById.set(agent.agentId, agent);
    state.sessionToAgentId.set(input.sessionKey, agent.agentId);
    return agent;
  }

  function disconnectAgent(sessionKey: string): void {
    const agent = getAgentBySessionKey(sessionKey);
    if (!agent || agent.builtin) {
      return;
    }
    agent.status = 'offline';
    agent.lastSeenAt = now();
    state.sessionToAgentId.delete(sessionKey);
  }

  function listAgents(): HubAgent[] {
    return [...state.agentsById.values()].map((agent) => ({ ...agent }));
  }

  return {
    disconnectAgent,
    getAgentBySessionKey,
    getSnapshot: () => {
      throw new AgentHubError('Not implemented yet.');
    },
    listAgents,
    listChannels: () => {
      throw new AgentHubError('Not implemented yet.');
    },
    on: () => {
      throw new AgentHubError('Not implemented yet.');
    },
    postMessage: () => {
      throw new AgentHubError('Not implemented yet.');
    },
    readMessages: () => {
      throw new AgentHubError('Not implemented yet.');
    },
    registerAgent,
  };
}
