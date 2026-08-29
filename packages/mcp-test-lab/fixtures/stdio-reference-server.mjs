import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

function createReferenceServer() {
  const server = new McpServer({
    name: 'brainstrike-sdk-v2-reference',
    version: '2.0.0',
  });
  const echoSchema = z.object({ text: z.string() });
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

function startFaultControl(configuration) {
  if (!configuration) {
    void serveStdio(createReferenceServer, { legacy: 'reject' });
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
      void serveStdio(createReferenceServer, { legacy: 'reject' });
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

const inheritedEnvironmentKeys = DEFAULT_INHERITED_ENV_VARS.filter(
  (key) => process.env[key] !== undefined
);
if (inheritedEnvironmentKeys.length > 0) {
  throw new Error(
    `MCP lab stdio fixture inherited ambient environment keys: ${inheritedEnvironmentKeys.join(', ')}`
  );
}
process.stderr.write('mcp-lab-stdio-ready\n');
setImmediate(() => process.stderr.write('mcp-lab-stdio-ready-second-chunk\n'));
startFaultControl(await readFaultConfiguration(faultConfigurationPath()));
