/**
 * Through the trusted model seam, the standalone host loads a trusted launch
 * root's instructions and the home skills, and runs a skill's Python script.
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { HOST_RESULT_SCHEMAS } from '@brainstrike/agent-host/protocol';
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  cleanup,
  drainCleanup,
  recordedToolResults,
  standaloneHost,
  trustedPlatformModule,
} from './fixtures/standalone-trusted-host.ts';

afterEach(drainCleanup);

test("the standalone host loads a trusted launch root's instructions and the home skills", {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'bs-trusted-model-home-'));
  cleanup.push(() => rm(home, { force: true, recursive: true }));
  await mkdir(join(home, '.brainstrike', 'skills', 'release-notes'), { recursive: true });
  await writeFile(
    join(home, '.brainstrike', 'skills', 'release-notes', 'SKILL.md'),
    '---\nname: release-notes\ndescription: Drafts release notes.\n---\nList every merged change under its ticket.'
  );
  // `skill` is a deferred tool: the model loads it by name, then activates the skill.
  const module = await trustedPlatformModule('trusted-fixture', [
    { input: { toolName: 'skill' }, toolId: 'load_tool' },
    { input: { name: 'release-notes' }, toolId: 'skill' },
  ]);
  const host = await standaloneHost({ HOME: home, USERPROFILE: home }, module, {
    'AGENTS.md': 'Every answer cites its ticket.',
  });
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  // ADR-0032: the launch root's instructions load once the person trusts it.
  expect(await host.command(['workspace', 'trust', host.workspace, '--yes'])).toMatchObject({
    code: 0,
  });
  const ran = await host.run('trusted-fixture::probe');
  expect(ran.result, ran.result.stderr).toMatchObject({ code: 0 });
  const events = (ran.rows ?? []).map((row) => row.event);
  const started = z
    .object({
      snapshot: z.object({
        configuration: z.object({ childSystem: z.string(), system: z.string() }),
      }),
    })
    .parse(
      events.find((event) => event.type === 'run.started'),
      { reportInput: true }
    );
  const { childSystem, system } = started.snapshot.configuration;
  // The run's instructions carry the root's AGENTS.md and the home skill's catalog entry.
  expect(system).toContain('Every answer cites its ticket.');
  expect(system).toContain('release-notes');
  // A delegated child inherits the same workspace context, not the parent's own prompt.
  expect(childSystem).toContain('Every answer cites its ticket.');
  expect(childSystem).toContain('release-notes');
  expect(system.length).toBeGreaterThan(childSystem.length);
  // The model reads the skill's instructions, loaded from disk by this host.
  const result = recordedToolResults(ran.rows).find(
    ({ toolCallId }) => toolCallId === 'recorded-call-2'
  );
  expect(
    z
      .object({ type: z.literal('text'), value: z.string() })
      .parse(result?.output, { reportInput: true }).value
  ).toContain('List every merged change under its ticket.');
});

test("the standalone host runs a skill's Python script on the system Python 3", {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'bs-trusted-model-home-'));
  cleanup.push(() => rm(home, { force: true, recursive: true }));
  const skill = join(home, '.brainstrike', 'skills', 'greeter');
  await mkdir(join(skill, 'scripts'), { recursive: true });
  await writeFile(
    join(skill, 'SKILL.md'),
    '---\nname: greeter\ndescription: Greets in Python.\n---\nRun scripts/greet.py.'
  );
  await writeFile(
    join(skill, 'scripts', 'greet.py'),
    'import sys\nprint(f"hello from python {sys.version_info[0]}")\n'
  );
  // The call names the launch root, known once the host's workspace exists, so the
  // trusted module is written before host start reads it.
  const moduleDirectory = await mkdtemp(join(tmpdir(), 'bs-trusted-model-module-'));
  cleanup.push(() => rm(moduleDirectory, { force: true, recursive: true }));
  const module = join(moduleDirectory, 'trusted-platform.mjs');
  const host = await standaloneHost(
    { HOME: home, USERPROFILE: home },
    module,
    {},
    async ({ workspace }) => {
      // runSkillScript is deferred and execute-risk: the model loads it, then the run asks.
      const written = await trustedPlatformModule('trusted-fixture', [
        { input: { toolName: 'brainstrike_runSkillScript' }, toolId: 'load_tool' },
        {
          input: {
            cwd: '.',
            root: basename(workspace),
            runtime: 'python3',
            scriptPath: 'scripts/greet.py',
            skillName: 'greeter',
          },
          toolId: 'brainstrike_runSkillScript',
        },
      ]);
      await copyFile(written, module);
    }
  );
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const asked = await host.command([
    'run',
    'Greet me.',
    '--model',
    'trusted-fixture::probe',
    '--json',
    '--non-interactive',
  ]);
  // A non-interactive run exits 2 at the approval it cannot answer.
  expect(asked.code, asked.stderr).toBe(2);
  const { runId, threadId } = z
    .object({ runId: z.string(), threadId: z.string() })
    .parse(JSON.parse(asked.stdout.split('\n')[0] || 'null'));
  const readRows = async () =>
    Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/read'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(JSON.parse((await host.command(['threads', 'show', '--thread', threadId])).stdout)).rows;
  const requested = (await readRows())
    .map((row) => row.event)
    .find((event) => event.type === 'interaction.requested');
  if (requested?.type !== 'interaction.requested') {
    throw new Error('The skill script asked for no approval');
  }
  const approved = await host.command([
    'interaction',
    'respond',
    '--thread',
    threadId,
    '--run',
    runId,
    '--interaction',
    requested.interactionId,
    '--decision',
    'approve',
  ]);
  expect(approved, approved.stderr).toMatchObject({ code: 0 });
  await expect
    .poll(async () => (await readRows()).some((row) => row.event.type === 'run.finished'), {
      timeout: 30_000,
    })
    .toBe(true);
  // The model sees the script's output, printed by the Python 3 on this machine's PATH.
  const finished = (await readRows())
    .map((row) => row.event)
    .find((event) => event.type === 'effect.finished' && event.toolCallId === 'recorded-call-2');
  expect(JSON.stringify(finished)).toContain('hello from python 3');
});
