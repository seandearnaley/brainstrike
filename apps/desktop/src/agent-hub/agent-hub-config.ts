/**
 * Strict, no-silent-fallback validation for the Agent Hub MCP server config.
 *
 * Malformed values throw (typos must not silently coerce); defaults live in
 * DEFAULT_AGENT_HUB_CONFIG and are applied by callers, never by the validator.
 */

export type AgentHubBindAddress = '0.0.0.0' | '127.0.0.1';

export interface AgentHubRuntimeConfig {
  /** Required (non-blank) when bindAddress is 0.0.0.0. */
  authToken: string | null;
  bindAddress: AgentHubBindAddress;
  enabled: boolean;
  maxMessagesPerChannel: number;
  port: number;
}

export const DEFAULT_AGENT_HUB_PORT = 4519;

export const DEFAULT_AGENT_HUB_CONFIG: AgentHubRuntimeConfig = {
  authToken: null,
  bindAddress: '127.0.0.1',
  enabled: false,
  maxMessagesPerChannel: 1000,
  port: DEFAULT_AGENT_HUB_PORT,
};

export class AgentHubConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentHubConfigError';
  }
}

const MIN_PORT = 1024;
const MAX_PORT = 65_535;
const MIN_MAX_MESSAGES = 10;
const MAX_MAX_MESSAGES = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function assertAgentHubConfig(value: unknown): AgentHubRuntimeConfig {
  if (!isRecord(value)) {
    throw new AgentHubConfigError('Agent hub config must be an object.');
  }
  const { authToken, bindAddress, enabled, maxMessagesPerChannel, port } = value;

  if (typeof enabled !== 'boolean') {
    throw new AgentHubConfigError('enabled must be a boolean.');
  }
  if (!Number.isInteger(port) || typeof port !== 'number' || port < MIN_PORT || port > MAX_PORT) {
    throw new AgentHubConfigError(
      `port must be an integer between ${MIN_PORT} and ${MAX_PORT}, received ${JSON.stringify(port)}.`
    );
  }
  if (bindAddress !== '127.0.0.1' && bindAddress !== '0.0.0.0') {
    throw new AgentHubConfigError(
      `bindAddress must be '127.0.0.1' or '0.0.0.0', received ${JSON.stringify(bindAddress)}.`
    );
  }
  if (authToken !== null && (typeof authToken !== 'string' || authToken.trim().length === 0)) {
    throw new AgentHubConfigError('authToken must be null or a non-blank string.');
  }
  if (
    !Number.isInteger(maxMessagesPerChannel) ||
    typeof maxMessagesPerChannel !== 'number' ||
    maxMessagesPerChannel < MIN_MAX_MESSAGES ||
    maxMessagesPerChannel > MAX_MAX_MESSAGES
  ) {
    throw new AgentHubConfigError(
      `maxMessagesPerChannel must be an integer between ${MIN_MAX_MESSAGES} and ${MAX_MAX_MESSAGES}, received ${JSON.stringify(maxMessagesPerChannel)}.`
    );
  }
  if (bindAddress === '0.0.0.0' && authToken === null) {
    throw new AgentHubConfigError(
      'Binding to 0.0.0.0 exposes the hub to the network; an auth token is required.'
    );
  }

  return { authToken, bindAddress, enabled, maxMessagesPerChannel, port };
}
