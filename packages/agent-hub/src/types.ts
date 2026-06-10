export type AgentColorKey = 'chart-1' | 'chart-2' | 'chart-3' | 'chart-4' | 'chart-5';

export type AgentStatus = 'offline' | 'online';

export interface RegisterAgentInput {
  capabilities?: string[];
  name: string;
  program?: string;
  /** MCP session id, or 'builtin' for the Brainstrike participant. */
  sessionKey: string;
  worktree?: string;
}

export interface HubAgent {
  agentId: string;
  builtin: boolean;
  capabilities: string[];
  color: AgentColorKey;
  joinedAt: number;
  lastSeenAt: number;
  name: string;
  program?: string;
  sessionKey: string;
  status: AgentStatus;
  tokensReceived: number;
  tokensSent: number;
  worktree?: string;
}

export interface HubMessage {
  channel: string;
  fromAgentId: string;
  fromColor: AgentColorKey;
  fromName: string;
  /** Monotonic per hub. */
  id: number;
  mentions: string[];
  postedAt: number;
  text: string;
  tokenCount: number;
}

export interface ReadMessagesResult {
  /** Highest message id in the channel (0 when empty). */
  latestId: number;
  /** Chronological order. */
  messages: HubMessage[];
  tokensUsed: number;
  /** True when budget or limit cut off older messages. */
  truncated: boolean;
}

export interface HubSnapshot {
  agents: HubAgent[];
  channels: string[];
  recentMessages: HubMessage[];
  totalMessages: number;
  totalTokens: number;
}

export interface HubEventMap {
  'agent-joined': HubAgent;
  'agent-left': HubAgent;
  'agent-updated': HubAgent;
  'message-posted': HubMessage;
}

export interface AgentHubOptions {
  /** Oldest messages are evicted beyond this per-channel cap. Default 1000. */
  maxMessagesPerChannel?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface PostMessageInput {
  channel?: string;
  mentions?: string[];
  sessionKey: string;
  text: string;
}

export interface ReadMessagesInput {
  channel?: string;
  limit?: number;
  maxTokens?: number;
  sessionKey: string;
  sinceId?: number;
}

export interface AgentHub {
  disconnectAgent(sessionKey: string): void;
  getAgentBySessionKey(sessionKey: string): HubAgent | undefined;
  getSnapshot(): HubSnapshot;
  listAgents(): HubAgent[];
  listChannels(): string[];
  on<E extends keyof HubEventMap>(event: E, cb: (payload: HubEventMap[E]) => void): () => void;
  postMessage(input: PostMessageInput): HubMessage;
  readMessages(input: ReadMessagesInput): ReadMessagesResult;
  registerAgent(input: RegisterAgentInput): HubAgent;
}
