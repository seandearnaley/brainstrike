import { appendFileSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

function absoluteArgument(prefix, label) {
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  const candidate = argument?.slice(prefix.length);
  if (candidate !== undefined && !isAbsolute(candidate)) {
    throw new Error(`MCP lab stdio ${label} must be an absolute path`);
  }
  return candidate;
}

// The client's version probe runs on a sibling process whose stderr it discards, so the
// process's own life is recorded here: when Node reached this module, how long the SDK
// imports took, when it served, its first request, and how it ended.
const traceFile = absoluteArgument('--brainstrike-trace-file=', 'trace file');
function trace(event, details = {}) {
  if (traceFile) {
    appendFileSync(
      traceFile,
      `${JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000), ...details })}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
  }
}
trace('evaluating');
process.on('exit', (code) => trace('exit', { code }));

let imported;
try {
  imported = await Promise.all([
    import('@modelcontextprotocol/client/stdio'),
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/server/stdio'),
    import('zod'),
  ]);
} catch (error) {
  trace('import-failed', { error: String(error?.stack ?? error) });
  throw error;
}
const [{ DEFAULT_INHERITED_ENV_VARS }, { McpServer }, { serveStdio }, { z }] = imported;
trace('imported');

let requested = false;
function createReferenceServer() {
  if (!requested) {
    requested = true;
    trace('first-request');
  }
  const server = new McpServer({
    name: 'brainstrike-sdk-v2-reference',
    version: '2.0.0',
  });
  const echoSchema = z.strictObject({ text: z.string() });
  server.registerTool(
    'echo',
    {
      description: 'Echo a string through the official MCP TypeScript SDK v2 server.',
      inputSchema: echoSchema,
      outputSchema: echoSchema,
    },
    async ({ text }) => ({
      content: [{ text, type: 'text' }],
      structuredContent: { text },
    })
  );
  return server;
}

function faultConfigurationPath() {
  const prefix = '--brainstrike-fault-control=';
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

function pidFilePath() {
  return absoluteArgument('--brainstrike-pid-file=', 'PID file');
}

// libuv writes these into every Windows child environment block that omits them, copying
// the spawner's own values (src/win/process.c `required_vars`). A Windows child therefore
// cannot observe whether its spawner passed them; the remaining default keys still can.
const WINDOWS_SPAWN_REQUIRED_ENV_VARS = new Set([
  'HOMEDRIVE',
  'HOMEPATH',
  'LOGONSERVER',
  'PATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]);
const OBSERVABLE_INHERITED_ENV_VARS = DEFAULT_INHERITED_ENV_VARS.filter(
  (key) => process.platform !== 'win32' || !WINDOWS_SPAWN_REQUIRED_ENV_VARS.has(key)
);

function expectedInheritedEnvironmentKeys() {
  const prefix = '--brainstrike-expected-inherited-env=';
  const argumentsForExpectation = process.argv.slice(2).filter((value) => value.startsWith(prefix));
  if (argumentsForExpectation.length > 1) {
    throw new Error('MCP lab stdio inherited environment expectation was provided more than once');
  }
  const encoded = argumentsForExpectation[0]?.slice(prefix.length) ?? '';
  const keys = encoded.length === 0 ? [] : encoded.split(',');
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !DEFAULT_INHERITED_ENV_VARS.includes(key))
  ) {
    throw new Error('MCP lab stdio inherited environment expectation is invalid');
  }
  return keys.filter((key) => OBSERVABLE_INHERITED_ENV_VARS.includes(key)).sort();
}

async function readFaultConfiguration(path) {
  if (!path) {
    return;
  }
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.exitArmed !== 'boolean' ||
    (parsed.stderrText !== undefined && typeof parsed.stderrText !== 'string') ||
    (parsed.exitCode !== undefined && !Number.isInteger(parsed.exitCode))
  ) {
    throw new Error('Invalid MCP lab stdio fault control configuration');
  }
  return { ...parsed, directory: dirname(path) };
}

function serve() {
  trace('serving');
  void serveStdio(createReferenceServer, {
    legacy: 'reject',
    onerror: (error) => trace('serve-error', { error: String(error?.stack ?? error) }),
  });
}

function startFaultControl(configuration) {
  if (!configuration) {
    serve();
    return;
  }
  const state = { lastSequence: 0, mcpStarted: false };
  let scanning = false;
  let timer;

  const writeStderr = (text) =>
    new Promise((resolve, reject) => {
      process.stderr.write(text, (error) => (error ? reject(error) : resolve()));
    });

  const parseCommand = (entry) => {
    const match = /^command-([0-9]{6})-(exit|start-mcp|stderr)$/u.exec(entry);
    if (!(match?.[1] && match[2])) {
      return;
    }
    return {
      command: match[2],
      sequence: Number(match[1]),
      sequenceText: match[1],
    };
  };

  const executeCommand = async ({ command, sequence, sequenceText }) => {
    if (sequence <= state.lastSequence) {
      return;
    }
    state.lastSequence = sequence;
    if (command === 'stderr' && configuration.stderrText !== undefined) {
      await writeStderr(configuration.stderrText);
    }
    if (command === 'start-mcp' && !state.mcpStarted) {
      state.mcpStarted = true;
      serve();
    }
    await writeFile(`${configuration.directory}/ack-${sequenceText}`, '', {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (command === 'start-mcp' && !configuration.exitArmed) {
      clearInterval(timer);
    }
    if (command === 'exit' && configuration.exitCode !== undefined) {
      process.exit(configuration.exitCode);
    }
  };

  const scan = async () => {
    if (scanning) {
      return;
    }
    scanning = true;
    try {
      const entries = (await readdir(configuration.directory))
        .filter((entry) => entry.startsWith('command-'))
        .sort();
      for (const entry of entries) {
        const parsed = parseCommand(entry);
        if (!parsed) {
          continue;
        }
        await executeCommand(parsed);
      }
    } finally {
      scanning = false;
    }
  };
  timer = setInterval(() => {
    scan().catch(() => {
      clearInterval(timer);
      process.stderr.write('mcp-lab-stdio-control-failed\n', () => process.exit(1));
    });
  }, 5);
}

const inheritedEnvironmentKeys = OBSERVABLE_INHERITED_ENV_VARS.filter(
  (key) => process.env[key] !== undefined
).sort();
const expectedEnvironmentKeys = expectedInheritedEnvironmentKeys();
if (
  inheritedEnvironmentKeys.length !== expectedEnvironmentKeys.length ||
  inheritedEnvironmentKeys.some((key, index) => key !== expectedEnvironmentKeys[index])
) {
  trace('environment-mismatch', {
    expected: expectedEnvironmentKeys,
    received: inheritedEnvironmentKeys,
  });
  throw new Error(
    `MCP lab stdio fixture inherited ambient environment mismatch: expected [${expectedEnvironmentKeys.join(', ')}], received [${inheritedEnvironmentKeys.join(', ')}]`
  );
}
const pidFile = pidFilePath();
if (pidFile) {
  await writeFile(pidFile, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
}
process.stderr.write('mcp-lab-stdio-ready\n');
setImmediate(() => process.stderr.write('mcp-lab-stdio-ready-second-chunk\n'));
startFaultControl(await readFaultConfiguration(faultConfigurationPath()));
