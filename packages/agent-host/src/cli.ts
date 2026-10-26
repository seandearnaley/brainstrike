#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BoundaryFailureError,
  describeBoundaryFailure,
  type ProviderCredential,
} from '@brainstrike/assistant-contract';
import { configureLogger } from '@brainstrike/logging';
import { Schema } from 'effect';
import { trustCliProjectHooks } from './cli-hooks-trust.ts';
import {
  HostCliExitError,
  type HostCliSessionOptions,
  pendingMcpInput,
  runHostCliSession,
} from './cli-session.ts';
import type { HostClient } from './client-connection.ts';
import type { HostPlatformLaunchOptions } from './platform-launch-options.ts';
import { isProcessEntrypoint } from './process-entrypoint.ts';
import { HOST_CLOSE_GRACE_MS, HOST_METHOD_SCHEMAS, type HostParams } from './protocol.ts';
import { openStandaloneHost, type StandaloneHost } from './standalone-host.ts';
import {
  type CliWorkspaceRunInput,
  CliWorkspaceRunInputSchema,
} from './standalone-workspace-input.ts';
import { startHostTracing } from './telemetry/otel.ts';
import { foldHostRuns } from './thread-view.ts';
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
  | 'mode'
  | 'query'
  | 'limit'
  | 'scope-root'
  | 'platform'
  | 'prompt'
  | 'provider'
  | 'region'
  | 'resume-data'
  | 'root'
  | 'run'
  | 'sha256'
  | 'since'
  | 'until'
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
      Record<CliBooleanOption, boolean> & {
        workspace: string[];
        'workspace-root': string[];
      }
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
      limit: { type: 'string' },
      'mcp-config': { type: 'string' },
      mode: { type: 'string' },
      model: { type: 'string' },
      'non-interactive': { type: 'boolean' },
      platform: { type: 'string' },
      prompt: { type: 'string' },
      provider: { type: 'string' },
      query: { type: 'string' },
      region: { type: 'string' },
      'resume-data': { type: 'string' },
      root: { type: 'string' },
      run: { type: 'string' },
      'scope-root': { type: 'string' },
      sha256: { type: 'string' },
      since: { type: 'string' },
      skills: { type: 'string' },
      thread: { type: 'string' },
      until: { type: 'string' },
      workspace: { multiple: true, type: 'string' },
      'workspace-instructions': { type: 'string' },
      'workspace-root': { multiple: true, type: 'string' },
    },
    strict: true,
  });
  const command = cliCommand(positionals, values.help);
  if (
    ![
      'help',
      'children list',
      'child stop',
      'thread start',
      'thread read',
      'threads list',
      'threads show',
      'threads search',
      'workspace search',
      'run',
      'attach',
      'run stop',
      'interaction respond',
      'interaction resume',
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
    ? Schema.decodeUnknownSync(CliWorkspaceRunInputSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })({
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
/** This command's host's trusted launch selection. */
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
): Promise<ProviderCredential> {
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
/** An ISO 8601 date (UTC midnight) or date-time, in ms since the epoch; NaN when it is neither. */
function cliTime(value: string): number {
  return /^\d{4}-\d{2}-\d{2}(T.+)?$/u.test(value) ? Date.parse(value) : Number.NaN;
}
/**
 * BST-1939: `threads search` asks for the lexical and title arms only; it
 * embeds no query. Invalid input is refused before any host starts, one
 * plain line per problem.
 */
function threadSearchParams(values: HostCliArguments['values']): HostParams<'thread/search'> {
  // A query of only whitespace searches for nothing: it is as missing as no query.
  const query = required(values.query?.trim() ? values.query : undefined, 'query');
  const problems: string[] = [];
  if (query.trim().length > 500) {
    problems.push('--query must be at most 500 characters');
  }
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 100)) {
    problems.push('--limit must be an integer from 1 to 100');
  }
  if (values['scope-root'] !== undefined && !values['scope-root'].trim()) {
    problems.push('--scope-root must name a workspace root');
  }
  const window: {
    since?: number;
    until?: number;
  } = {};
  for (const name of ['since', 'until'] as const) {
    const value = values[name];
    if (value === undefined) {
      continue;
    }
    const time = cliTime(value);
    if (Number.isFinite(time)) {
      window[name] = time;
    } else {
      problems.push(`--${name} must be an ISO 8601 date or date-time`);
    }
  }
  if (window.since !== undefined && window.until !== undefined && window.since > window.until) {
    problems.push('--since must not be after --until');
  }
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
  return Schema.decodeSync(HOST_METHOD_SCHEMAS['thread/search'], {
    errors: 'all',
    onExcessProperty: 'error',
  })({
    query,
    ...(limit === undefined ? {} : { limit }),
    ...(values['scope-root'] === undefined ? {} : { rootId: values['scope-root'] }),
    ...window,
  });
}
/** The `threads search` request, refused before any host starts when its input is invalid. */
function cliThreadSearch(
  command: string,
  values: HostCliArguments['values']
): HostParams<'thread/search'> | undefined {
  return command === 'threads search' ? threadSearchParams(values) : undefined;
}
async function searchWorkspaceCli(client: HostClient, values: HostCliArguments['values']) {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error('Workspace search interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    return await client.request(
      'workspace/search',
      Schema.decodeUnknownSync(HOST_METHOD_SCHEMAS['workspace/search'], {
        errors: 'all',
        onExcessProperty: 'error',
      })({
        limit: Number(values.limit ?? 20),
        mode: required(values.mode, 'mode'),
        query: required(values.query, 'query'),
        rootId: required(values['scope-root'], 'scope-root'),
        threadId: required(values.thread, 'thread'),
      }),
      controller.signal
    );
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
type CliSessionOutput = Pick<HostCliSessionOptions, 'interactive' | 'json' | 'output'>;
/**
 * After an answer, the resumed run continues in this command's host: it is
 * followed silently, so the command's output stays the answer's one result and
 * its exit code says whether the run ended (0 or 1) or asks again (2).
 */
const ANSWER_FOLLOW: CliSessionOutput = {
  interactive: false,
  json: true,
  output: { write: () => undefined },
};
/** The run this command follows next: the thread's own running run, or any run in its tree awaiting a person. */
async function nextFollowedRun(
  client: HostClient,
  threadId: string,
  root = true
): Promise<{ readonly runId: string; readonly threadId: string } | undefined> {
  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
  const run = foldHostRuns(rows).find(
    ({ approvals, runId, status }) =>
      status === 'running' &&
      (root || approvals.length > 0 || pendingMcpInput(rows, runId) !== undefined)
  );
  if (run) {
    return { runId: run.runId, threadId };
  }
  const { children } = await client.request('thread/children', { threadId });
  for (const child of children) {
    const followed = await nextFollowedRun(client, child.threadId, false);
    if (followed) {
      return followed;
    }
  }
  return undefined;
}
/**
 * Everything this command's host does after its run (background children, the
 * parent runs their results wake, a child's follow-up) runs in this process:
 * keep the host open until no work holds it. Each later run on the thread is
 * followed like the first, and each decision any of that work asks for is put
 * to the person as `attach` puts it; a non-interactive command exits 2 there.
 */
async function settleHostWork(
  host: StandaloneHost,
  threadId: string,
  session: CliSessionOutput,
  printedSeq = 0
): Promise<void> {
  const { client } = host;
  const printed = new Map([[threadId, printedSeq]]);
  let changed = Promise.withResolvers<void>();
  const releaseChildren = client.onChildrenChanged(() => changed.resolve());
  const releaseRows = client.onEvent((row) => {
    if (row.threadId === threadId) {
      changed.resolve();
    }
  });
  try {
    await client.request('log/subscribe', { fromSeq: 0, threadId });
    for (;;) {
      changed = Promise.withResolvers<void>();
      const idle = host.idle().then(() => true);
      const followed = await nextFollowedRun(client, threadId);
      if (followed) {
        printed.set(
          followed.threadId,
          await runHostCliSession({
            ...session,
            afterSeq: printed.get(followed.threadId) ?? 0,
            client,
            ...followed,
          })
        );
      } else if (await Promise.race([idle, changed.promise.then(() => false)])) {
        break;
      }
    }
  } finally {
    releaseChildren();
    releaseRows();
  }
  // A session that EOF or a signal ended throws past this: the host's close ends the subscription.
  await client.request('log/unsubscribe', { threadId });
}
/** Runs one command, closing the host it opened once the command's outcome is out. */
export async function runHostCli(
  args: string[],
  output: HostCliOutput = process.stdout,
  defaults: HostCliDefaults = {}
): Promise<void> {
  const opened: { host?: StandaloneHost } = {};
  try {
    await runHostCliCommand(args, output, defaults, opened);
  } finally {
    await opened.host?.close();
  }
}
/** Runs one command; the host it opens is left in `opened` for its caller to close. */
async function runHostCliCommand(
  args: string[],
  output: HostCliOutput,
  defaults: HostCliDefaults,
  opened: { host?: StandaloneHost }
): Promise<void> {
  const { command, interactive, positionals, values, workspaceInput } = parseHostCliArgs(args);
  const workspaceConfiguration = cliWorkspaceConfiguration(workspaceInput);
  if (command === 'help') {
    output.write(`brainstrike --data-root <path> [--platform <module>] <command>

run "prompt" --model <id> [--thread <id>] [--json] [--non-interactive]
attach --thread <id> [--run <id>] [--json] [--interactive]
workspace search --thread <id> --scope-root <id> --mode bm25|trigram --query <text> [--limit <n>]
threads list
threads show --thread <id> [--from-seq <n>]
threads search --query <text> [--scope-root <id>] [--since <iso>] [--until <iso>] [--limit <n>]
thread start | thread read --thread <id>
run stop --thread <id> --run <id>
children list --thread <parent-id>
child stop --thread <child-id> --run <id>
interaction respond --thread <id> --run <id> --interaction <id> --decision approve|deny
interaction resume --thread <id> --run <id> --interaction <id> --resume-data <json>
auth login --provider <id> [--region <aws region> [--aws-profile <name>]]
hooks trust [<root dir>] [--sha256 <hash>]

Each command runs the agent host in its own process and ends it when the command ends.
A data root that another Brainstrike process has open (the desktop, another command) is refused.
run --thread <id> continues any thread, a child thread included.

auth login reads the API key or AWS bearer key from stdin, never from arguments.
--aws-profile stores a named AWS profile chain and reads no secret.
hooks trust shows a standalone root's .brainstrike/hooks.json (default: the current directory)
and its SHA-256 for review; the host runs its project hooks only at that hash. --sha256
confirms without a prompt. Desktop roots are approved in Settings > Hooks.

threads search is lexical: words in committed messages and thread titles, fused into one
ranked list; with no thread holding every word, it matches any word and says so. --scope-root
keeps threads bound to that workspace root; --since/--until bound message times.
Question answers use {"answer":"text"} or {"answer":["choice 1","choice 2"]}.
Plan decisions use {"action":"approved"} or {"action":"rejected","feedback":"reason"}.
Runs use an explicit --model provider::model from the canonical catalog.
This selection does not change desktop model enablement or saved settings.
A command's workspace is its launch roots: repeat --workspace <dir> (default:
the current directory). File, task-list and canvas tools run there.
Per-run workspace input for a profile-backed host: repeat --workspace-root <existing canonical id>,
--workspace-instructions inherit|off, and --skills inherit|off (default off).
Selectors narrow live owner grants; they never add paths.
An empty selection grants no workspace; Skills also require the owner's home-tier capability.
Search/shell tools, Skills/workspace instructions, vector Memory,
local inference and browser OAuth require platform capabilities.
The host composes configured MCP servers and their Tasks from --mcp-config <file> (the desktop's MCP config JSON).
MCP server input is answered in an interactive terminal; a non-interactive run exits 2 at one.
Credential backends require an explicit existing keyring service or absolute private file:
--credential-store keyring --credential-service <service>
--credential-store file --credential-file <path>
Missing keyring support never selects file automatically.
Unanswered noninteractive decisions exit 2 and remain available for attach and interaction respond/resume,
which follow the resumed run until it ends or asks again.
An interactive terminal prompts for approvals, question answers, plan decisions and MCP input.
EOF or a signal ends the command: a running run is interrupted, an unanswered decision stays for attach.
`);
    return;
  }
  // The secret is read before any host starts, so empty input never opens one.
  const login = await readCliLogin(command, values, process.stdin);
  // Likewise, invalid search input is refused before a host starts.
  const threadSearch = cliThreadSearch(command, values);
  const platformModule = values.platform ?? defaults.platformModule;
  if (!platformModule) {
    throw new Error(
      'Opening a host requires --platform <module>; this entry composes no default platform'
    );
  }
  const host = await openStandaloneHost(
    resolve(required(values['data-root'] ?? values.root, 'data-root')),
    platformModule,
    launchSelection(values)
  );
  opened.host = host;
  const client = host.client;
  const commandId = values['command-id'] ?? randomUUID();
  const print = (value: unknown): void => {
    output.write(`${JSON.stringify(value)}\n`);
  };
  const threadId = (): string => required(values.thread, 'thread');
  const runId = (): string => required(values.run, 'run');
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
    case 'thread start':
      print(await client.request('thread/start', { commandId }));
      break;
    case 'workspace search':
      print(await searchWorkspaceCli(client, values));
      break;
    case 'children list':
      print(await client.request('thread/children', { threadId: threadId() }));
      break;
    case 'threads search':
      print(await client.request('thread/search', required(threadSearch, 'query')));
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
      const session = { interactive, json: values.json ?? false, output };
      const printed = await runHostCliSession({
        ...session,
        client,
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
      await settleHostWork(host, selected, session, printed);
      break;
    }
    case 'attach': {
      const session = { interactive, json: values.json ?? false, output };
      const printed = await runHostCliSession({
        ...session,
        client,
        ...(values.run ? { runId: values.run } : {}),
        threadId: threadId(),
      });
      await settleHostWork(host, threadId(), session, printed);
      break;
    }
    case 'child stop':
    case 'run stop':
      print(await client.request('run/stop', { commandId, runId: runId(), threadId: threadId() }));
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
      await settleHostWork(host, threadId(), ANSWER_FOLLOW);
      break;
    }
    case 'interaction resume': {
      const resumeData: unknown = JSON.parse(required(values['resume-data'], 'resume-data'));
      const params = Schema.decodeUnknownSync(HOST_METHOD_SCHEMAS['interaction/resume'], {
        errors: 'all',
        onExcessProperty: 'error',
      })({
        commandId,
        interactionId: required(values.interaction, 'interaction'),
        resumeData,
        runId: runId(),
        threadId: threadId(),
      });
      print(await client.request('interaction/resume', params));
      await settleHostWork(host, threadId(), ANSWER_FOLLOW);
      break;
    }
    default:
      throw new Error('Expected thread start/read, run stop, or interaction respond/resume');
  }
}
function reportHostCliFailure(cause: unknown): void {
  const message =
    cause instanceof BoundaryFailureError
      ? describeBoundaryFailure(cause.failure)
      : cause instanceof Error
        ? cause.message
        : String(cause);
  process.stderr.write(`${message}\n`);
  // The command's own outcome keeps its code when its host's close fails after it.
  process.exitCode ??= cause instanceof HostCliExitError ? cause.exitCode : 1;
}
/** Both installed executable names and the direct Node entry share exit semantics. */
export async function runHostCliProcess(
  args: string[],
  defaults: HostCliDefaults = {}
): Promise<void> {
  // Stdout carries the command's output; the in-process host logs to stderr.
  configureLogger({ console: { destination: 2 }, level: 'warn' });
  if (process.platform === 'win32') {
    // ADR-0017: before the host starts any native process this process joins a
    // kill-on-close Job, so everything the host starts ends with the command.
    (
      createRequire(import.meta.url)(
        '@brainstrike/windows-job-native'
      ) as typeof import('@brainstrike/windows-job-native')
    ).initialize();
  }
  const opened: { host?: StandaloneHost } = {};
  let tracing: Awaited<ReturnType<typeof startHostTracing>>;
  try {
    // Before the host starts: a misconfigured exporter fails the command visibly.
    tracing = await startHostTracing(process.env);
    await runHostCliCommand(args, process.stdout, defaults, opened);
  } catch (cause: unknown) {
    reportHostCliFailure(cause);
  }
  // ADR-0031: the command's outcome is out, and every write is already committed.
  // The host's close is the ask and the one grace bounds it; this process's exit
  // is the kill (on Windows its kill-on-close Job ends every child too). A close
  // that ends sooner lets the process end on its own.
  setTimeout(() => {
    process.stderr.write(
      `The host did not close within ${HOST_CLOSE_GRACE_MS} ms; its committed work is kept.\n`
    );
    process.exit();
  }, HOST_CLOSE_GRACE_MS).unref();
  try {
    await opened.host?.close();
    // After the host closed and joined its runs, so their spans are flushed too.
    await tracing?.shutdown();
  } catch (cause: unknown) {
    reportHostCliFailure(cause);
  }
}
if (isProcessEntrypoint(import.meta.url)) {
  void runHostCliProcess(process.argv.slice(2));
}
