import { countTokensHeuristic } from '@brainstrike/utils/token-counting-heuristics';
import { AGENT_COLOR_KEYS, BUILTIN_AGENT_COLOR, colorForIndex } from './agent-colors';
import type {
  AgentHub,
  AgentHubOptions,
  HubAgent,
  HubEventMap,
  HubMessage,
  HubSnapshot,
  PostMessageInput,
  ReadMessagesInput,
  ReadMessagesResult,
  RegisterAgentInput,
} from './types';

export const BUILTIN_SESSION_KEY = 'builtin';
export const BUILTIN_AGENT_NAME = 'brainstrike';
export const DEFAULT_CHANNEL = '#general';
const DEFAULT_MAX_MESSAGES_PER_CHANNEL = 1000;

export class AgentHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentHubError';
  }
}

interface HubState {
  agentsById: Map<string, HubAgent>;
  channels: Map<string, HubMessage[]>;
  colorCursor: number;
  maxMessagesPerChannel: number;
  nextMessageId: number;
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

const SNAPSHOT_RECENT_MESSAGE_LIMIT = 100;

type HubListeners = {
  [E in keyof HubEventMap]: Set<(payload: HubEventMap[E]) => void>;
};

export function createAgentHub(options: AgentHubOptions = {}): AgentHub {
  const now = options.now ?? (() => Date.now());
  const listeners: HubListeners = {
    'agent-joined': new Set(),
    'agent-left': new Set(),
    'agent-updated': new Set(),
    'message-posted': new Set(),
  };

  function emit<E extends keyof HubEventMap>(event: E, payload: HubEventMap[E]): void {
    for (const listener of listeners[event]) {
      listener(payload);
    }
  }

  function on<E extends keyof HubEventMap>(
    event: E,
    cb: (payload: HubEventMap[E]) => void
  ): () => void {
    listeners[event].add(cb);
    return () => {
      listeners[event].delete(cb);
    };
  }
  const state: HubState = {
    agentsById: new Map(),
    channels: new Map([[DEFAULT_CHANNEL, []]]),
    colorCursor: 0,
    maxMessagesPerChannel: options.maxMessagesPerChannel ?? DEFAULT_MAX_MESSAGES_PER_CHANNEL,
    nextMessageId: 1,
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
    emit('agent-joined', { ...agent });
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
    emit('agent-left', { ...agent });
  }

  function listAgents(): HubAgent[] {
    return [...state.agentsById.values()].map((agent) => ({ ...agent }));
  }

  function requireSender(sessionKey: string): HubAgent {
    const agent = getAgentBySessionKey(sessionKey);
    if (!agent) {
      throw new AgentHubError('Not registered. Call hub_register first.');
    }
    return agent;
  }

  function postMessage(input: PostMessageInput): HubMessage {
    const sender = requireSender(input.sessionKey);
    const text = input.text.trim();
    if (text.length === 0) {
      throw new AgentHubError('Message text must not be empty.');
    }
    const channel = input.channel ?? DEFAULT_CHANNEL;
    const message: HubMessage = {
      channel,
      fromAgentId: sender.agentId,
      fromColor: sender.color,
      fromName: sender.name,
      id: state.nextMessageId,
      mentions: input.mentions ?? [],
      postedAt: now(),
      text,
      tokenCount: countTokensHeuristic(text),
    };
    state.nextMessageId += 1;

    const existing = state.channels.get(channel);
    const messages = existing ?? [];
    if (!existing) {
      state.channels.set(channel, messages);
    }
    messages.push(message);
    if (messages.length > state.maxMessagesPerChannel) {
      messages.splice(0, messages.length - state.maxMessagesPerChannel);
    }

    sender.tokensSent += message.tokenCount;
    sender.lastSeenAt = message.postedAt;
    emit('message-posted', { ...message });
    emit('agent-updated', { ...sender });
    return message;
  }

  function readMessages(input: ReadMessagesInput): ReadMessagesResult {
    const reader = requireSender(input.sessionKey);
    const channel = input.channel ?? DEFAULT_CHANNEL;
    const all = state.channels.get(channel) ?? [];
    const candidates =
      input.sinceId === undefined
        ? all
        : all.filter((message) => message.id > (input.sinceId ?? 0));

    const selected: HubMessage[] = [];
    let tokensUsed = 0;
    let truncated = false;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const message = candidates[index];
      if (!message) {
        continue;
      }
      const overBudget =
        input.maxTokens !== undefined && tokensUsed + message.tokenCount > input.maxTokens;
      const overLimit = input.limit !== undefined && selected.length >= input.limit;
      if (overBudget || overLimit) {
        truncated = true;
        break;
      }
      selected.push(message);
      tokensUsed += message.tokenCount;
    }
    selected.reverse();

    reader.tokensReceived += tokensUsed;
    reader.lastSeenAt = now();
    if (tokensUsed > 0) {
      emit('agent-updated', { ...reader });
    }
    const lastMessage = all.at(-1);
    return {
      latestId: lastMessage ? lastMessage.id : 0,
      messages: selected,
      tokensUsed,
      truncated,
    };
  }

  function listChannels(): string[] {
    return [...state.channels.keys()];
  }

  function getSnapshot(): HubSnapshot {
    const allMessages = [...state.channels.values()].flat().sort((a, b) => a.id - b.id);
    return {
      agents: listAgents(),
      channels: listChannels(),
      recentMessages: allMessages.slice(-SNAPSHOT_RECENT_MESSAGE_LIMIT).map((m) => ({ ...m })),
      totalMessages: allMessages.length,
      totalTokens: allMessages.reduce((sum, message) => sum + message.tokenCount, 0),
    };
  }

  return {
    disconnectAgent,
    getAgentBySessionKey,
    getSnapshot,
    listAgents,
    listChannels,
    on,
    postMessage,
    readMessages,
    registerAgent,
  };
}
