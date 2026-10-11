#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { launchHost } from '@brainstrike/host-lease';
import { trustCliProjectHooks } from './cli-hooks-trust.js';
import { readCliMcpInput, settleCliMcpInput } from './cli-mcp-input.js';
import { HostCliExitError, runHostCliSession } from './cli-session.js';
import { attachAgentHost, type HostClient } from './client.js';
import { createAgentHostSpawner } from './launcher.js';
import type { HostPlatformLaunchOptions } from './platform-launch-options.js';
import { isProcessEntrypoint } from './process-entrypoint.js';
import { HOST_METHOD_SCHEMAS, type HostLoginCredential, type HostParams } from './protocol.js';
import {
  type CliWorkspaceRunInput,
  CliWorkspaceRunInputSchema,
} from './standalone-workspace-input.js';

export interface HostCliOutput {
  write(value: string): void;
}
/** Supplied by the composing executable; this Core entry has no built-in platform. */
export interface HostCliDefaults {
  readonly platformModule?: string;
}
function required<T>(value: T | undefined, name: string): T {
  if (!value) {
    throw new Error(`Missing --${name}`);
  }
  return value;
}

type CliStringOption =
  | 'action'
  | 'aws-profile'
  | 'command-id'
  | 'credential-file'
  | 'credential-service'
  | 'credential-store'
  | 'data-root'
  | 'decision'
  | 'from-seq'
  | 'content'
  | 'interaction'
  | 'mcp-config'
  | 'model'
  | 'platform'
  | 'prompt'
  | 'provider'
  | 'region'
  | 'resume-data'
  | 'root'
  | 'run'
  | 'sha256'
  | 'skills'
  | 'workspace-instructions'
  | 'thread';
type CliBooleanOption = 'help' | 'interactive' | 'json' | 'non-interactive';
interface HostCliArguments {
  readonly command: string;
  readonly interactive: boolean;
  readonly positionals: readonly string[];
  readonly values: Partial<
    Record<CliStringOption, string> &
      Record<CliBooleanOption, boolean> & { workspace: string[]; 'workspace-root': string[] }
  >;
  readonly workspaceInput?: CliWorkspaceRunInput;
}

/** The command the positionals name; `run "prompt"` and `hooks trust [dir]` carry an argument. */
function cliCommand(positionals: readonly string[], help: boolean | undefined): string {
  if (help) {
    return 'help';
  }
  if (positionals[0] === 'run' && !['start', 'stop'].includes(positionals[1] ?? '')) {
    return 'run';
  }
  // `hooks trust [dir]` names the root to trust, never a launch selection.
  if (positionals[0] === 'hooks' && positionals[1] === 'trust' && positionals.length <= 3) {
    return 'hooks trust';
  }
  return positionals.join(' ');
}

function parseHostCliArgs(args: string[]): HostCliArguments {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      action: { type: 'string' },
      'aws-profile': { type: 'string' },
      'command-id': { type: 'string' },
      content: { type: 'string' },
      'credential-file': { type: 'string' },
      'credential-service': { type: 'string' },
      'credential-store': { type: 'string' },
      'data-root': { type: 'string' },
      decision: { type: 'string' },
      'from-seq': { type: 'string' },
      help: { type: 'boolean' },
      interaction: { type: 'string' },
      interactive: { type: 'boolean' },
      json: { type: 'boolean' },
      'mcp-config': { type: 'string' },
      model: { type: 'string' },
      'non-interactive': { type: 'boolean' },
      platform: { type: 'string' },
      prompt: { type: 'string' },
      provider: { type: 'string' },
      region: { type: 'string' },
      'resume-data': { type: 'string' },
      root: { type: 'string' },
      run: { type: 'string' },
      sha256: { type: 'string' },
      skills: { type: 'string' },
      thread: { type: 'string' },
      workspace: { multiple: true, type: 'string' },
      'workspace-instructions': { type: 'string' },
      'workspace-root': { multiple: true, type: 'string' },
    },
    strict: true,
  });
  const command = cliCommand(positionals, values.help);
  if (
    ![
      'host start',
      'host status',
      'host stop',
      'help',
      'children list',
      'child send',
      'child input',
      'child stop',
      'thread start',
      'thread read',
      'threads list',
      'threads show',
      'run',
      'attach',
      'run start',
      'run stop',
      'interaction respond',
      'interaction resume',
      'log follow',
      'mcp input read',
      'mcp input settle',
      'auth login',
      'hooks trust',
    ].includes(command)
  ) {
    throw new Error('Unknown host command');
  }
  if (values.root && values['data-root'] && resolve(values.root) !== resolve(values['data-root'])) {
    throw new Error('--root and --data-root must select the same data root');
  }
  if (values.interactive && values['non-interactive']) {
    throw new Error('Choose interactive or non-interactive input');
  }
  const hasWorkspaceInput =
    values['workspace-root'] !== undefined ||
    values.skills !== undefined ||
    values['workspace-instructions'] !== undefined;
  if (hasWorkspaceInput && command !== 'run' && command !== 'run start') {
    throw new Error('Workspace selectors and preferences apply only to run or run start');
  }
  const workspaceInput = hasWorkspaceInput
    ? CliWorkspaceRunInputSchema.parse({
        kind: 'cli-workspace',
        version: 1,
        workspace: {
          instructions: values['workspace-instructions'] ?? 'inherit',
          rootIds: values['workspace-root'] ?? [],
          skills: values.skills ?? 'off',
        },
      })
    : undefined;
  return {
    command,
    interactive: !values['non-interactive'] && (values.interactive ?? Boolean(process.stdin.isTTY)),
    positionals,
    values,
    ...(workspaceInput ? { workspaceInput } : {}),
  };
}

/** A newly started standalone host's trusted launch selection. */
function launchSelection(values: HostCliArguments['values']): HostPlatformLaunchOptions {
  const mcpConfig = values['mcp-config'];
  return {
    ...credentialSelection(values),
    ...(mcpConfig ? { mcpConfig: { path: resolve(mcpConfig) } } : {}),
    workspaceRoots: (values.workspace ?? [process.cwd()]).map((root) => resolve(root)),
  };
}

function credentialSelection(
  values: HostCliArguments['values']
): Pick<HostPlatformLaunchOptions, 'credentialStore'> | undefined {
  const kind = values['credential-store'];
  const file = values['credential-file'];
  const service = values['credential-service'];
  if (!(kind || file || service)) {
    return undefined;
  }
  if (kind === 'file' && !service) {
    return { credentialStore: { kind, path: required(file, 'credential-file') } };
  }
  if (kind === 'keyring' && !file) {
    return { credentialStore: { kind, service: required(service, 'credential-service') } };
  }
  throw new Error(
    'Select --credential-store keyring --credential-service <existing service>, or --credential-store file --credential-file <absolute path>'
  );
}

function assertCredentialAuthority(spawned: boolean, values: HostCliArguments['values']): void {
  if (
    !spawned &&
    (values['credential-store'] || values['credential-file'] || values['credential-service'])
  ) {
    throw new Error(
      'An attached host retains its existing credential authority; credential backend selection requires a new host'
    );
  }
  if (!spawned && values['mcp-config']) {
    throw new Error(
      'An attached host retains its existing MCP configuration; --mcp-config requires a new host'
    );
  }
  if (!spawned && values.workspace) {
    throw new Error(
      'An attached host retains its workspace roots; --workspace applies only to a newly started standalone host'
    );
  }
}

async function readCliSecret(input: NodeJS.ReadableStream): Promise<string> {
  let text = '';
  for await (const chunk of input) {
    text += String(chunk);
  }
  const secret = text.trim();
  if (!secret) {
    throw new Error('auth login reads the secret from stdin, and stdin was empty');
  }
  return secret;
}

async function readCliLogin(
  command: string,
  values: HostCliArguments['values'],
  input: NodeJS.ReadableStream
): Promise<HostParams<'auth/login'> | undefined> {
  if (command !== 'auth login') {
    return;
  }
  const provider = required(values.provider, 'provider');
  return { credential: await readCliLoginCredential(values, input), provider };
}

async function readCliLoginCredential(
  values: HostCliArguments['values'],
  input: NodeJS.ReadableStream
): Promise<HostLoginCredential> {
  const region = values.region;
  if (values['aws-profile']) {
    return {
      mode: 'profile_chain',
      profile: values['aws-profile'],
      region: required(region, 'region'),
      type: 'aws',
    };
  }
  const secret = await readCliSecret(input);
  return region
    ? { bearerKey: secret, mode: 'bearer', region, type: 'aws' }
    : { key: secret, type: 'api_key' };
}

function cliWorkspaceConfiguration(input: CliWorkspaceRunInput | undefined): {
  configuration?: CliWorkspaceRunInput;
} {
  return input ? { configuration: input } : {};
}

/** Named child controls refuse a top-level thread before issuing a mutation. */
async function assertChildCommand(
  client: HostClient,
  command: string,
  selected: string | undefined
): Promise<void> {
  if (!command.startsWith('child ')) {
    return;
  }
  const { rows } = await client.request('thread/read', {
    fromSeq: 0,
    threadId: required(selected, 'thread'),
  });
  const started = rows.find(({ event }) => event.type === 'thread.started')?.event;
  if (started?.type !== 'thread.started' || !('origin' in started)) {
    throw new Error(`${command} requires a child thread`);
  }
}

/** CLI is a client of the root owner; it never runs a second model/tool loop. */
export async function runHostCli(
  args: string[],
  output: HostCliOutput = process.stdout,
  defaults: HostCliDefaults = {}
): Promise<void> {
  const { command, interactive, positionals, values, workspaceInput } = parseHostCliArgs(args);
  const workspaceConfiguration = cliWorkspaceConfiguration(workspaceInput);
  if (command === 'help') {
    output.write(`brainstrike --data-root <path> [--platform <module>] <command>

run "prompt" --model <id> [--thread <id>] [--json] [--non-interactive]
attach --thread <id> [--run <id>] [--json] [--interactive]
threads list
threads show --thread <id> [--from-seq <n>]
host start | host status | host stop
thread start | thread read --thread <id>
run start --thread <id> --model <id> --prompt <text>
run stop --thread <id> --run <id>
children list --thread <parent-id>
child send --thread <child-id> --model <id> --prompt <text>
child input --thread <child-id> --run <id> --model <id> --prompt <text>
child stop --thread <child-id> --run <id>
interaction respond --thread <id> --run <id> --interaction <id> --decision approve|deny
interaction resume --thread <id> --run <id> --interaction <id> --resume-data <json>
log follow --thread <id> [--from-seq <n>]
mcp input read --thread <id> --run <id> --interaction <id>
mcp input settle --thread <id> --run <id> --interaction <id> --action accept|decline|cancel [--content <json>]
auth login --provider <id> [--region <aws region> [--aws-profile <name>]]
hooks trust [<root dir>] [--sha256 <hash>]

auth login reads the API key or AWS bearer key from stdin, never from arguments.
--aws-profile stores a named AWS profile chain and reads no secret.
hooks trust shows a standalone root's .brainstrike/hooks.json (default: the current directory)
and its SHA-256 for review; the host runs its project hooks only at that hash. --sha256
confirms without a prompt. Desktop roots are approved in Settings > Hooks.

Question answers use {"answer":"text"} or {"answer":["choice 1","choice 2"]}.
Plan decisions use {"action":"approved"} or {"action":"rejected","feedback":"reason"}.
Standalone hosts use an explicit --model provider::model from the canonical catalog.
This selection does not change desktop model enablement or saved settings.
A newly started standalone host's workspace is its launch roots: repeat
--workspace <dir> (default: the current directory). File, task-list and canvas
tools run there; an attached host keeps its own roots.
Per-run workspace input for a profile-backed host: repeat --workspace-root <existing canonical id>,
--workspace-instructions inherit|off, and --skills inherit|off (default off).
Selectors narrow live owner grants; they never add paths.
An empty selection grants no workspace; Skills also require the owner's home-tier capability.
Search/shell tools, Skills/workspace instructions, vector Memory,
local inference and browser OAuth require platform capabilities.
An existing host keeps its own platform and admission policy.
A new host composes configured MCP servers and their Tasks from --mcp-config <file> (the desktop's MCP config JSON).
The interaction id is the committed mcp.input.requested event's interactionId; a non-interactive run exits 2 at one.
Credential backends require an explicit existing keyring service or absolute private file:
--credential-store keyring --credential-service <service>
--credential-store file --credential-file <path>
Selections apply only to a newly started host. Missing keyring support never selects file automatically.
Unanswered noninteractive decisions exit 2 and remain available for attach.
An interactive terminal prompts for approvals, question answers, and plan decisions. EOF detaches.
Run signals stop and join its execution; attach signals detach.
`);
    return;
  }
  // The secret is read before any host starts, so empty input never spawns one.
  const login = await readCliLogin(command, values, process.stdin);
  let spawned = false;
  const attachment = await launchHost(
    resolve(required(values['data-root'] ?? values.root, 'data-root')),
    {
      attach: attachAgentHost,
      lifetime: command === 'host start' ? 'persistent' : 'cli',
      spawn: async (options, signal) => {
        if (command === 'host status' || command === 'host stop') {
          throw new Error('No host is running for this root');
        }
        const platformModule = values.platform ?? defaults.platformModule;
        if (!platformModule) {
          throw new Error(
            'Starting a host requires --platform <module>; this entry composes no default platform'
          );
        }
        await createAgentHostSpawner(platformModule, launchSelection(values))(options, signal);
        spawned = true;
      },
    }
  );
  // This launcher has exactly one supplied attachment implementation.
  const client = attachment as HostClient;
  const commandId = values['command-id'] ?? randomUUID();
  const print = (value: unknown): void => {
    output.write(`${JSON.stringify(value)}\n`);
  };
  const threadId = (): string => required(values.thread, 'thread');
  const runId = (): string => required(values.run, 'run');
  try {
    assertCredentialAuthority(spawned, values);
    await assertChildCommand(client, command, values.thread);
    switch (command) {
      case 'hooks trust':
        print(
          await trustCliProjectHooks(client, {
            interactive,
            root: positionals[2],
            sha256: values.sha256,
          })
        );
        break;
      case 'auth login': {
        print(await client.request('auth/login', required(login, 'provider')));
        break;
      }
      case 'host start':
      case 'host status': {
        const { hostVersion, pid, protocolVersion, start } = client.record;
        print({ hostVersion, pid, protocolVersion, start });
        break;
      }
      case 'host stop': {
        const result = await client.request('host/stop', {});
        // Protocol 6 acknowledges joined Core/platform/Root cleanup, then joins
        // the requesting transport. Both must complete before CLI success.
        await client.closed;
        print(result);
        break;
      }
      case 'thread start':
        print(await client.request('thread/start', { commandId }));
        break;
      case 'children list':
        print(await client.request('thread/children', { threadId: threadId() }));
        break;
      case 'threads list':
        print(await client.request('thread/list', {}));
        break;
      case 'thread read':
      case 'threads show':
        print(
          await client.request('thread/read', {
            fromSeq: Number(values['from-seq'] ?? 0),
            threadId: threadId(),
          })
        );
        break;
      case 'run': {
        const modelId = required(values.model, 'model');
        const prompt = required(values.prompt ?? positionals.slice(1).join(' '), 'prompt');
        const selected =
          values.thread ??
          (await client.request('thread/start', { commandId: randomUUID() })).threadId;
        await runHostCliSession({
          client,
          interactive,
          json: values.json ?? false,
          output,
          startRun: () =>
            client.request('run/start', {
              commandId,
              ...workspaceConfiguration,
              modelId,
              prompt,
              threadId: selected,
            }),
          threadId: selected,
        });
        break;
      }
      case 'attach':
        await runHostCliSession({
          client,
          interactive,
          json: values.json ?? false,
          output,
          ...(values.run ? { runId: values.run } : {}),
          threadId: threadId(),
        });
        break;
      case 'child send':
      case 'run start':
        print(
          await client.request('run/start', {
            commandId,
            ...workspaceConfiguration,
            modelId: required(values.model, 'model'),
            prompt: required(values.prompt, 'prompt'),
            threadId: threadId(),
          })
        );
        break;
      case 'child input':
        print(
          await client.request('run/input', {
            commandId,
            modelId: required(values.model, 'model'),
            prompt: required(values.prompt, 'prompt'),
            runId: runId(),
            threadId: threadId(),
          })
        );
        break;
      case 'child stop':
      case 'run stop':
        print(
          await client.request('run/stop', { commandId, runId: runId(), threadId: threadId() })
        );
        break;
      case 'interaction respond': {
        const decision = values.decision;
        if (decision !== 'approve' && decision !== 'deny') {
          throw new Error('--decision must be approve or deny');
        }
        print(
          await client.request('interaction/respond', {
            commandId,
            decision,
            interactionId: required(values.interaction, 'interaction'),
            runId: runId(),
            threadId: threadId(),
          })
        );
        break;
      }
      case 'interaction resume': {
        const resumeData: unknown = JSON.parse(required(values['resume-data'], 'resume-data'));
        const params = HOST_METHOD_SCHEMAS['interaction/resume'].parse({
          commandId,
          interactionId: required(values.interaction, 'interaction'),
          resumeData,
          runId: runId(),
          threadId: threadId(),
        });
        print(await client.request('interaction/resume', params));
        break;
      }
      case 'mcp input read':
        print(
          await readCliMcpInput(client, {
            interactionId: required(values.interaction, 'interaction'),
            runId: runId(),
            threadId: threadId(),
          })
        );
        break;
      case 'mcp input settle':
        print(
          await settleCliMcpInput(
            client,
            {
              interactionId: required(values.interaction, 'interaction'),
              runId: runId(),
              threadId: threadId(),
            },
            { action: values.action, commandId, content: values.content }
          )
        );
        break;
      case 'log follow': {
        const selected = threadId();
        const rows = new Map<number, unknown>();
        let cursor = Number(values['from-seq'] ?? 0);
        const accept = (row: { threadId: string; seq: number }): void => {
          if (row.threadId !== selected || row.seq <= cursor) {
            return;
          }
          rows.set(row.seq, row);
          while (rows.has(cursor + 1)) {
            cursor += 1;
            print(rows.get(cursor));
            rows.delete(cursor);
          }
        };
        const release = client.onEvent(accept);
        const detach = (): void => {
          void client.close();
        };
        process.once('SIGINT', detach);
        process.once('SIGTERM', detach);
        try {
          for (const row of (
            await client.request('log/subscribe', { fromSeq: cursor, threadId: selected })
          ).rows) {
            accept(row);
          }
          await client.closed;
        } finally {
          release();
          process.off('SIGINT', detach);
          process.off('SIGTERM', detach);
        }
        break;
      }
      default:
        throw new Error(
          'Expected host start/status/stop, thread start/read, run start/stop, interaction respond/resume, mcp input read/settle, or log follow'
        );
    }
  } finally {
    await client.close();
  }
}

/** Both installed executable names and the direct Node entry share exit semantics. */
export async function runHostCliProcess(
  args: string[],
  defaults: HostCliDefaults = {}
): Promise<void> {
  try {
    await runHostCli(args, process.stdout, defaults);
  } catch (cause: unknown) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = cause instanceof HostCliExitError ? cause.exitCode : 1;
  }
}

if (isProcessEntrypoint(import.meta.url)) {
  void runHostCliProcess(process.argv.slice(2));
}
