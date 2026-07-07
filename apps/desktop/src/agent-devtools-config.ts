import agentDevToolsDefaults from '../agent-devtools-defaults.json';

export type AgentDevtoolsConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly host: '127.0.0.1';
      readonly port: number;
    };

type EnvLike = Readonly<Record<string, string | undefined>>;

interface ElectronCommandLineLike {
  appendSwitch: (name: string, value: string) => void;
}

const DEFAULT_AGENT_DEVTOOLS_PORT = agentDevToolsDefaults.defaultPort;
const DEFAULT_AGENT_DEVTOOLS_HOST = agentDevToolsDefaults.defaultHost as '127.0.0.1';
const MIN_PORT = agentDevToolsDefaults.minPort;
const MAX_PORT = agentDevToolsDefaults.maxPort;

export function resolveAgentDevtoolsConfig(
  env: EnvLike,
  argv: readonly string[]
): AgentDevtoolsConfig {
  const enabled =
    env['BRAINSTRIKE_AGENT_DEVTOOLS'] === '1' || argv.includes('--brainstrike-agent-devtools');

  if (!enabled) {
    return { enabled: false };
  }

  const host = resolveHost(env['BRAINSTRIKE_AGENT_DEVTOOLS_HOST']);
  const port = resolvePort(env['BRAINSTRIKE_AGENT_DEVTOOLS_PORT'], argv);
  return { enabled: true, host, port };
}

export function toAgentDevtoolsSwitches(
  config: AgentDevtoolsConfig
): ReadonlyArray<readonly [name: string, value: string]> {
  if (!config.enabled) {
    return [];
  }
  return [
    ['remote-debugging-port', String(config.port)],
    ['remote-debugging-address', config.host],
  ];
}

export function configureAgentDevtoolsCommandLine(
  commandLine: ElectronCommandLineLike,
  env: EnvLike,
  argv: readonly string[]
): void {
  const config = resolveAgentDevtoolsConfig(env, argv);
  for (const [name, value] of toAgentDevtoolsSwitches(config)) {
    commandLine.appendSwitch(name, value);
  }
}

function resolveHost(value: string | undefined): '127.0.0.1' {
  const host = value?.trim() || DEFAULT_AGENT_DEVTOOLS_HOST;
  if (host === '127.0.0.1') {
    return host;
  }
  throw new Error('BRAINSTRIKE_AGENT_DEVTOOLS_HOST must be 127.0.0.1.');
}

function resolvePort(envValue: string | undefined, argv: readonly string[]): number {
  const argvValue = argv
    .find((arg: string): boolean => arg.startsWith('--brainstrike-agent-devtools-port='))
    ?.split('=')[1];
  // Keep env precedence explicit so launched desktop sessions can override inherited argv.
  const raw = envValue?.trim() || argvValue?.trim() || String(DEFAULT_AGENT_DEVTOOLS_PORT);
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || String(port) !== raw || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `BRAINSTRIKE_AGENT_DEVTOOLS_PORT must be an integer from ${MIN_PORT} to ${MAX_PORT}.`
    );
  }
  return port;
}
