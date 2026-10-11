/**
 * Lifecycle hooks on the CLI host (the real production bin): a global
 * PreToolUse hook blocks a tool the policy would ask about, through the same
 * approval gate, and the block's reason is committed with the call. A launch
 * root's project hooks run only once `hooks trust` pins their reviewed hash.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_RESULT_SCHEMAS } from '@brainstrike/agent-host/protocol';
import { removeFixtureRoot } from '@brainstrike/agent-host/test-fixtures/cooperative-host';
import { HostRunNotices } from '@brainstrike/agent-host/thread-view';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { writeStdoutHook } from './fixtures/native-hook-command.js';

const bin = fileURLToPath(new URL('../bin/brainstrike.mjs', import.meta.url));
const httpFixture = new URL('./fixtures/standalone-production-http.mjs', import.meta.url).href;
const REASON = 'Questions are disabled in this workspace';
const cleanup: (() => Promise<void>)[] = [];

function command(dataRoot: string, home: string, args: readonly string[]) {
  return new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
    execFile(
      process.execPath,
      [bin, '--data-root', dataRoot, ...args],
      {
        cwd: tmpdir(),
        env: {
          // The global hooks file is `$HOME/.brainstrike/hooks.json`.
          BRAINSTRIKE_M3_STANDALONE_HTTP: 'question',
          BRAINSTRIKE_M3_STANDALONE_RECEIPT: join(dataRoot, 'offline-receipt.jsonl'),
          BRAINSTRIKE_OPENAI_API_KEY: 'offline-standalone-fixture',
          HOME: home,
          LC_ALL: 'C',
          NODE_OPTIONS: `--import=${httpFixture}`,
          PATH: process.env['PATH'],
          SystemRoot: process.env['SystemRoot'],
          TZ: 'UTC',
          USERPROFILE: home,
        },
        timeout: 20_000,
        windowsHide: true,
      },
      (cause, stdout, stderr) => {
        if (!cause) {
          resolve({ code: 0, stderr, stdout });
        } else if (typeof cause.code === 'number') {
          resolve({ code: cause.code, stderr, stdout });
        } else {
          reject(cause);
        }
      }
    );
  });
}

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

/** A started CLI host under an optional global hooks file and launch workspace root. */
async function startCliHost(options: {
  readonly hooks?: (home: string) => Record<string, unknown>;
  readonly workspace?: string;
}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-m3-host-hooks-'));
  const home = await mkdtemp(join(tmpdir(), 'bs-m3-host-hooks-home-'));
  cleanup.push(() => rm(home, { force: true, recursive: true }));
  cleanup.push(async () => {
    const owner = RootLock.inspect(dataRoot)?.owner;
    if (owner && !owner.released) {
      const record = decodeHostRecord(
        JSON.parse(await readFile(join(dataRoot, 'host.json'), 'utf8'))
      );
      expect(await command(dataRoot, home, ['host', 'stop'])).toMatchObject({
        code: 0,
        stderr: '',
      });
      expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
      // Owner-approved Windows allowance (2026-10-11): the cold host spent
      // 1.435s saving Node's compile cache after successful Root release.
      // Still require physical retirement; a successful stop reply is not exit.
      await expect
        .poll(
          () => processStartTime(record.pid),
          process.platform === 'win32' ? { timeout: 5000 } : undefined
        )
        .toBeNull();
    }
    await removeFixtureRoot(dataRoot);
  });
  await mkdir(join(home, '.brainstrike'));
  if (options.hooks) {
    await writeFile(join(home, '.brainstrike', 'hooks.json'), JSON.stringify(options.hooks(home)));
  }
  const cli = (args: readonly string[]) => command(dataRoot, home, args);
  const workspace = options.workspace ? ['--workspace', options.workspace] : [];
  expect(await cli(['host', 'start', ...workspace])).toMatchObject({ code: 0, stderr: '' });
  /** One run of the offline question fixture in a new thread, with its committed rows. */
  const run = async () => {
    const result = await cli([
      'run',
      'Use the recorded canonical human interaction.',
      '--model',
      'openai::gpt-6-sol',
      '--json',
      '--non-interactive',
    ]);
    const { runId, threadId } = z
      .object({ runId: z.string(), threadId: z.string() })
      .parse(JSON.parse(result.stdout.split('\n')[0] ?? ''));
    const shown = await cli(['threads', 'show', '--thread', threadId]);
    const { rows } = HOST_RESULT_SCHEMAS['thread/read'].parse(JSON.parse(shown.stdout));
    return { code: result.code, rows, runId, stderr: result.stderr };
  };
  return { cli, run };
}

/** A CLI host under a global hooks file, running the offline question fixture once. */
async function runUnderHooks(hooks: (home: string) => Record<string, unknown>) {
  return await (await startCliHost({ hooks })).run();
}

/** The question tool, blocked by a PreToolUse hook so the run completes instead of pausing. */
const blockQuestion = (root: string) => ({
  command: writeStdoutHook(root, { decision: 'block', reason: REASON }, 2),
  matcher: { tool_name: 'askUser' },
  type: 'command',
});

test('a global PreToolUse hook blocks a tool on the CLI host, with its reason committed', async () => {
  const { code, rows, stderr } = await runUnderHooks((home) => ({
    PreToolUse: [blockQuestion(home)],
  }));
  // The blocked question is never asked: the run completes instead of pausing.
  expect(code, stderr).toBe(0);
  expect(rows.some(({ event }) => event.type === 'interaction.requested')).toBe(false);
  expect(rows.some(({ event }) => event.type === 'effect.started')).toBe(false);
  const responses = rows.flatMap(({ event }) =>
    event.type === 'stream.chunk' &&
    typeof event.chunk === 'object' &&
    event.chunk !== null &&
    !Array.isArray(event.chunk) &&
    event.chunk['type'] === 'tool-approval-response'
      ? [event.chunk]
      : []
  );
  expect(responses).toEqual([expect.objectContaining({ approved: false, reason: REASON })]);
});

test('a Stop hook’s verdict labels the CLI run with a committed hook verdict', async () => {
  const { rows, runId } = await runUnderHooks((home) => ({
    PreToolUse: [blockQuestion(home)],
    Stop: [
      {
        command: writeStdoutHook(home, {
          brainstrikeRunVerdict: { detail: 'Graded', verdict: 'succeeded' },
        }),
        type: 'command',
      },
    ],
  }));
  const events = rows.map(({ event }) => event);
  const types = events.map((event) => event.type);
  expect(types.indexOf('run.verdict')).toBe(types.indexOf('run.finished') - 1);
  expect(events.find((event) => event.type === 'run.verdict')).toEqual({
    detail: 'Graded',
    runId,
    source: 'hook',
    type: 'run.verdict',
    verdict: 'succeeded',
  });
});

test('a UserPromptSubmit hook that blocks the prompt ends the CLI run with its reason', async () => {
  const { rows } = await runUnderHooks((home) => ({
    UserPromptSubmit: [
      {
        command: writeStdoutHook(home, { decision: 'block', reason: 'Prompts are paused' }, 2),
        type: 'command',
      },
    ],
  }));
  expect(rows.some(({ event }) => event.type === 'model.step')).toBe(false);
  expect(rows.find(({ event }) => event.type === 'run.finished')?.event).toMatchObject({
    detail: 'The request was blocked by a hook: Prompts are paused',
    outcome: 'failed',
  });
});

test("a launch root's project hook runs on the CLI host only once hooks trust pins its hash", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-hooks-ws-')));
  cleanup.push(() => rm(workspace, { force: true, recursive: true }));
  const hooks = JSON.stringify({ PreToolUse: [blockQuestion(workspace)] });
  await mkdir(join(workspace, '.brainstrike'));
  await writeFile(join(workspace, '.brainstrike', 'hooks.json'), hooks);
  const sha256 = createHash('sha256').update(hooks).digest('hex');
  const asked = (rows: readonly { readonly event: { readonly type: string } }[]) =>
    rows.some(({ event }) => event.type === 'interaction.requested');
  const host = await startCliHost({ workspace });

  const skipped = (rows: Awaited<ReturnType<typeof host.run>>['rows']) =>
    rows.flatMap(({ event }) => (event.type === 'hooks.skipped' ? [event] : []));
  const hooksPath = join(workspace, '.brainstrike', 'hooks.json');

  // Untrusted, the project file adds no hook: the question is asked, and the
  // run names the file it skipped, which the CLI shows with its remedy.
  const untrusted = await host.run();
  expect(untrusted.code).toBe(2);
  expect(asked(untrusted.rows)).toBe(true);
  expect(skipped(untrusted.rows)).toEqual([
    {
      files: [
        {
          detail: 'not trusted',
          path: hooksPath,
          reason: 'untrusted',
          rootId: workspace,
          scope: 'project',
        },
      ],
      runId: untrusted.runId,
      type: 'hooks.skipped',
    },
  ]);
  const notices = new HostRunNotices();
  expect(untrusted.rows.flatMap((row) => notices.read(row))).toEqual([
    `Project hooks not trusted: ${hooksPath}: not trusted — review it with \`brainstrike hooks trust <root dir>\` (desktop roots: Settings > Hooks)`,
  ]);

  // Unattended, a trust needs the reviewed hash, and the host refuses a stale one.
  const trust = (...args: string[]) => host.cli(['hooks', 'trust', workspace, ...args]);
  const unreviewed = await trust('--non-interactive');
  expect(unreviewed.code, unreviewed.stderr).toBe(2);
  expect(unreviewed.stderr).toContain(`--sha256 ${sha256}`);
  const stale = await trust('--sha256', '0'.repeat(64));
  expect(stale.code).toBe(1);
  expect(stale.stderr).toContain('changed since it was reviewed');

  const trusted = await trust('--sha256', sha256);
  expect(trusted).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(trusted.stdout)).toEqual({ rootId: workspace, sha256, trusted: true });

  // Trusted, the project hook blocks the question, so the run completes.
  const blocked = await host.run();
  expect(blocked.code, blocked.stderr).toBe(0);
  expect(asked(blocked.rows)).toBe(false);
  expect(skipped(blocked.rows)).toEqual([]);
});
