#!/usr/bin/env node
// pnpm cassettes:record <scenario id|all>
//
// Records provider cassettes one scenario at a time, stopping at the first
// failure. Each scenario runs against its real provider, holding the key you
// have exported in this shell (OPENROUTER_API_KEY, ANTHROPIC_API_KEY or
// OPENAI_API_KEY). Most record on the standalone host (the host lane); one
// marked `recordedIn: 'desktop'` records in the desktop app (the desktop E2E,
// which gets this shell's basics and that one key under its own name, nothing
// else: E2E global setup strips inherited provider credentials) and then
// replays in the host lane for the renderer-projection checks. A cassette is
// written only once it is clean, shows its scenario's behavior, keeps every
// invariant and replays to the same shape; a desktop recording the host lane
// cannot replay is taken back. Review the shape snapshot diff afterwards.
// See docs/agents/provider-cassettes.md.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  cassetteFile,
  PROVIDER_CASSETTE_SCENARIOS,
  recorderKey,
} from '../apps/desktop/e2e/utils/provider-cassette-scenarios.ts';

const RECORD_ENV = 'BRAINSTRIKE_PROVIDER_CASSETTE_RECORD';
const RECORDER_KEY_ENV = 'BRAINSTRIKE_PROVIDER_CASSETTE_RECORDER_KEY';
const UPSTREAMS_ENV = 'BRAINSTRIKE_PROVIDER_CASSETTE_UPSTREAMS';
/** What the desktop E2E needs from this shell besides the scenario's key. */
const DESKTOP_SHELL_ENV = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TERM',
  'TMPDIR',
  'USER',
];

const [requested, ...extra] = process.argv.slice(2);
if (!requested || extra.length > 0) {
  console.error('Usage: pnpm cassettes:record <scenario id|all>');
  process.exit(2);
}
const scenarios =
  requested === 'all'
    ? PROVIDER_CASSETTE_SCENARIOS
    : PROVIDER_CASSETTE_SCENARIOS.filter((scenario) => scenario.id === requested);
if (scenarios.length === 0) {
  console.error(
    `No provider cassette scenario ${requested}. Scenarios: ${PROVIDER_CASSETTE_SCENARIOS.map((scenario) => scenario.id).join(', ')}`
  );
  process.exit(2);
}

function run(command, args, env, cwd) {
  return spawnSync(command, args, { cwd, env, stdio: 'inherit' }).status ?? 1;
}

/** Records (or, for a desktop scenario, replays) `id` in the host lane, writing its shape file. */
function hostLane(id, env) {
  return run(
    'pnpm',
    [
      '--filter',
      '@brainstrike/desktop',
      'test:provider-cassettes',
      '-u',
      '-t',
      `provider cassette ${id} `,
    ],
    env
  );
}

/** The desktop E2E's whole environment: this shell's basics and the scenario's key. */
function desktopEnvironment(scenario, key) {
  return {
    ...Object.fromEntries(
      [...DESKTOP_SHELL_ENV, UPSTREAMS_ENV]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]])
    ),
    // As the desktop package's test:e2e runs it.
    ['BRAINSTRIKE_DISABLE_FILE_LOGS']: '1',
    ['LOG_LEVEL']: 'warn',
    [RECORDER_KEY_ENV]: key,
    [RECORD_ENV]: scenario.id,
  };
}

function recordInDesktop(scenario) {
  let key;
  try {
    key = recorderKey(scenario);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const file = cassetteFile(scenario);
  const previous = existsSync(file) ? readFileSync(file) : undefined;
  const { [RECORD_ENV]: _record, ...replayEnv } = process.env;
  // The first failing step's status, or 0 once all three pass.
  const status =
    run(
      'node',
      [
        'scripts/run-turbo-command.mjs',
        '--',
        'run',
        'build',
        '--filter',
        '@brainstrike/desktop...',
      ],
      process.env
    ) ||
    run(
      'pnpm',
      [
        'exec',
        'xvfb-maybe',
        'playwright',
        'test',
        'e2e/provider-cassettes.desktop.test.ts',
        '--workers=1',
        '--retries=0',
        '--trace=off',
        '--grep',
        `provider cassette ${scenario.id}(,| )`,
      ],
      desktopEnvironment(scenario, key),
      'apps/desktop'
    ) ||
    hostLane(scenario.id, replayEnv);
  if (status !== 0) {
    if (previous) {
      writeFileSync(file, previous);
    } else {
      rmSync(file, { force: true });
    }
    console.error(`${scenario.id}: not recorded; ${file} is as it was.`);
  }
  return status;
}

for (const scenario of scenarios) {
  const status =
    scenario.recordedIn === 'desktop'
      ? recordInDesktop(scenario)
      : hostLane(scenario.id, { ...process.env, [RECORD_ENV]: scenario.id });
  if (status !== 0) {
    process.exit(status);
  }
}
