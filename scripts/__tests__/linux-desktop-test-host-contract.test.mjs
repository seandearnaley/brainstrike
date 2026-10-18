/**
 * BST-2127: every lane that runs desktop's integration proofs runs them on the
 * one shared Linux desktop test host.
 *
 * WHY THIS GUARD EXISTS. Nightly Coverage gained xvfb and the desktop model
 * cache (#3813) while the Unit lane kept its own fence-only provisioning. The
 * first hosted run with Unit shards (Test run 39066362173) then failed
 * desktop's real-app proofs in all three desktop shards: 42x "Missing X server
 * or $DISPLAY", 14x "Process failed to launch" and 3x
 * "BRAINSTRIKE_M3_TRANSFORMERS_CACHE_ORIGIN must identify an existing
 * app-origin transformers-cache". Both lanes now call
 * `.github/actions/linux-desktop-test-host`, so they cannot drift again.
 *
 * For every matrix row of a runnable (scheduled or dispatchable) workflow whose
 * turbo `test:integration` / `test:coverage` step selects @brainstrike/desktop:
 *
 *   1. the same job runs the host action, unconditionally, before that step;
 *   2. the host action provisions the model cache for that row;
 *   3. the step's command, rendered for that row, runs under
 *      `xvfb-run --auto-servernum`.
 *
 * And for every row of every integration/coverage lane in a job that runs the
 * host, whatever it selects:
 *
 *   4. the step's command, rendered for that row, runs under
 *      `xvfb-run --auto-servernum`.
 *
 * Desktop is not the only package whose integration launches Electron:
 * sqlite-query's utility pass and indexer's scoped-electron proof do too, and
 * Unit (rest) died at the first one with "Missing X server or $DISPLAY" (Test
 * run 39079872105) while xvfb-run wrapped only desktop rows. Rule 4 does not
 * census which packages launch Electron, which would go dark when one more
 * does; like the host step, the X server comes with every lane on the host.
 *
 * The host action itself must install xvfb and provision the cache under an X
 * server. The fence half of the same action is pinned by
 * linux-fence-lane-contract.test.mjs, and its apt ordering by
 * apt-source-guard-contract.test.mjs.
 *
 * Rows are rendered by substituting the few matrix-expression shapes these
 * workflows use. Any other matrix expression in a checked field throws, so the
 * renderer cannot silently misread a new shape.
 *
 * Per the BST-836 discipline every assertion is control-tested against a
 * mutated copy of the source: a guard never observed failing is not evidence.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const hostActionPath = path.join(
  repoRoot,
  '.github',
  'actions',
  'linux-desktop-test-host',
  'action.yml'
);

const HOST_USES = './.github/actions/linux-desktop-test-host';
const DESKTOP = '@brainstrike/desktop';
const LANE = /\bturbo\s+run\s+test:(?:integration|coverage)(?=\s|$)/u;
const DIRECT_DESKTOP_LANE =
  /(?<!!)@brainstrike\/desktop\b[^\n]*?\btest:(?:integration|coverage)(?=\s|$)/u;
const UNIT_MATRIX = /^\$\{\{\s*fromJSON\(needs\.static\.outputs\.unit-matrix\)\s*\}\}$/u;

/** The floor: 3 desktop Unit rows x 2 integration steps, plus Nightly Coverage's desktop shard. */
const KNOWN_DESKTOP_LANE_ROWS = 7;
/** The floor: 9 Unit rows x 2 integration steps, plus Nightly Coverage's 6 package shards. */
const KNOWN_HOST_LANE_ROWS = 24;
const KNOWN_DESKTOP_LANE_WORKFLOWS = ['nightly-coverage.yml', 'test.yml'];

function readWorkflow(file) {
  return readFileSync(path.join(workflowsDir, file), 'utf8');
}

function hostActionSource() {
  return readFileSync(hostActionPath, 'utf8');
}

/** Workflows that can run: hosted CI is nightly plus manual dispatch. */
function runnableWorkflowSources() {
  const sources = new Map();
  for (const file of readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml'))
    .sort()) {
    const source = readWorkflow(file);
    const triggers = parseYaml(source)?.on ?? {};
    if (
      typeof triggers === 'object' &&
      ('schedule' in triggers || 'workflow_dispatch' in triggers)
    ) {
      sources.set(file, source);
    }
  }
  return sources;
}

/** Substitute the matrix-expression shapes the workflows use for one row. */
function renderForRow(text, row) {
  return String(text ?? '').replace(/\$\{\{\s*([^}]*?)\s*\}\}/gu, (whole, body) => {
    if (!/\bmatrix\./u.test(body)) {
      return whole;
    }
    const value = /^matrix\.([\w-]+)$/u.exec(body);
    if (value) {
      return String(row[value[1]] ?? '');
    }
    const equals = /^matrix\.([\w-]+) == '([^']*)'$/u.exec(body);
    if (equals) {
      return String(row[equals[1]] === equals[2]);
    }
    const choice = /^matrix\.([\w-]+) == '([^']*)' && '([^']*)' \|\| '([^']*)'$/u.exec(body);
    if (choice) {
      return row[choice[1]] === choice[2] ? choice[3] : choice[4];
    }
    throw new Error(`unsupported matrix expression in a desktop lane check: ${whole}`);
  });
}

function filterValues(command) {
  return [...command.matchAll(/--filter[=\s]+(?:"([^"]*)"|'([^']*)'|(\S+))/gu)].map(
    (match) => match[1] ?? match[2] ?? match[3]
  );
}

/**
 * Whether one positive turbo filter can select desktop. `X...` adds X's
 * dependencies, so only desktop itself selects desktop; `...X` adds X's
 * dependents, which can include desktop. Globs, directories and git ranges
 * can select it too.
 */
function filterSelectsDesktop(filter) {
  if (filter.startsWith('...')) {
    return true;
  }
  const name = filter.replace(/\.\.\.$/u, '');
  return /^@brainstrike\/[a-z0-9-]+$/u.test(name) ? name === DESKTOP : true;
}

/** Whether a rendered lane command runs desktop's integration proofs. */
function selectsDesktop(command) {
  if (DIRECT_DESKTOP_LANE.test(command)) {
    return true;
  }
  if (!LANE.test(command)) {
    return false;
  }
  const filters = filterValues(command);
  if (filters.includes(`!${DESKTOP}`)) {
    return false;
  }
  const positives = filters.filter((filter) => !filter.startsWith('!'));
  return positives.length === 0 || positives.some(filterSelectsDesktop);
}

function matrixRows(workflow, job) {
  const matrix = job.strategy?.matrix;
  if (matrix === undefined) {
    return [{}];
  }
  if (typeof matrix === 'string' && UNIT_MATRIX.test(matrix.trim())) {
    // Unit selection only drops rows of this full matrix (select-unit-shards.mjs).
    const selection = workflow.jobs?.static?.steps?.find((step) => step.id === 'unit-shards');
    return JSON.parse(selection.env.UNIT_MATRIX).include;
  }
  if (Array.isArray(matrix?.include) && Object.keys(matrix).length === 1) {
    return matrix.include;
  }
  throw new Error(`unsupported matrix source for a desktop lane: ${JSON.stringify(matrix)}`);
}

/** Every (workflow, job, step, row) whose lane command runs desktop's integration. */
function desktopLaneRows(sources) {
  const found = [];
  for (const [file, source] of sources) {
    const workflow = parseYaml(source);
    for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      steps.forEach((step, index) => {
        if (!(LANE.test(step?.run ?? '') || DIRECT_DESKTOP_LANE.test(step?.run ?? ''))) {
          return;
        }
        for (const row of matrixRows(workflow, job)) {
          const command = renderForRow(step.run, row).replace(/\s+/gu, ' ').trim();
          if (selectsDesktop(command)) {
            const label = `${file} › ${jobName} › ${step.name ?? `step ${index}`} [${row.shard ?? 'no matrix'}]`;
            found.push({ command, file, index, label, row, steps });
          }
        }
      });
    }
  }
  return found;
}

function assertDesktopLanesUseTheHost(sources = runnableWorkflowSources()) {
  const rows = desktopLaneRows(sources);
  assert.ok(
    rows.length >= KNOWN_DESKTOP_LANE_ROWS,
    `expected at least ${KNOWN_DESKTOP_LANE_ROWS} desktop integration rows, found ${rows.length}; if lanes really were removed, lower the floor deliberately rather than letting this detector go dark`
  );
  const files = new Set(rows.map((row) => row.file));
  for (const file of KNOWN_DESKTOP_LANE_WORKFLOWS) {
    assert.ok(files.has(file), `the detector no longer sees desktop's integration in ${file}`);
  }
  for (const { command, index, label, row, steps } of rows) {
    const hostIndex = steps.findIndex((step) => step?.uses === HOST_USES);
    assert.ok(
      hostIndex !== -1 && hostIndex < index,
      `${label} runs desktop's integration with no earlier \`uses: ${HOST_USES}\` step in the same job; its real-app proofs then fail at launch`
    );
    const host = steps[hostIndex];
    assert.equal(
      host.if,
      undefined,
      `${label}: the desktop test host step must not be conditional`
    );
    assert.equal(
      renderForRow(host.with?.['model-cache'], row),
      'true',
      `${label}: the host must provision the desktop model cache for this row, or the ordinary vector-search proof fails`
    );
    assert.match(
      command,
      /^xvfb-run --auto-servernum /u,
      `${label}: desktop's real-app proofs launch Electron and must run under \`xvfb-run --auto-servernum\``
    );
  }
}

/** Every (workflow, job, step, row) whose integration/coverage lane runs in a job with the host. */
function hostLaneRows(sources) {
  const found = [];
  for (const [file, source] of sources) {
    const workflow = parseYaml(source);
    for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      if (!steps.some((step) => step?.uses === HOST_USES)) {
        continue;
      }
      steps.forEach((step, index) => {
        if (!(LANE.test(step?.run ?? '') || DIRECT_DESKTOP_LANE.test(step?.run ?? ''))) {
          return;
        }
        for (const row of matrixRows(workflow, job)) {
          const command = renderForRow(step.run, row).replace(/\s+/gu, ' ').trim();
          const label = `${file} › ${jobName} › ${step.name ?? `step ${index}`} [${row.shard ?? 'no matrix'}]`;
          found.push({ command, label });
        }
      });
    }
  }
  return found;
}

function assertHostLanesRunUnderItsDisplay(sources = runnableWorkflowSources()) {
  const rows = hostLaneRows(sources);
  assert.ok(
    rows.length >= KNOWN_HOST_LANE_ROWS,
    `expected at least ${KNOWN_HOST_LANE_ROWS} integration rows on the desktop test host, found ${rows.length}; if lanes really were removed, lower the floor deliberately rather than letting this detector go dark`
  );
  const bare = rows
    .filter(({ command }) => !command.startsWith('xvfb-run --auto-servernum '))
    .map(({ label }) => label);
  assert.deepEqual(
    bare,
    [],
    `integration on the desktop test host must run under \`xvfb-run --auto-servernum\`; Electron passes outside desktop (sqlite-query, indexer) fail without an X server:\n${bare.join('\n')}`
  );
}

function assertHostActionProvidesTheDisplayAndCache(source = hostActionSource()) {
  const action = parseYaml(source);
  assert.equal(action?.runs?.using, 'composite', `${HOST_USES} must be a composite action`);
  assert.equal(
    action?.inputs?.['model-cache']?.default,
    'false',
    'the model cache is opt-in: only desktop rows need it'
  );
  const steps = action.runs.steps;
  const install = steps.find((step) => /\bapt-get install\b/u.test(step?.run ?? ''));
  assert.match(
    install?.run ?? '',
    /\bapt-get install\b[^\n]*\bxvfb\b/u,
    'the host must install xvfb: callers run desktop proofs under xvfb-run'
  );
  const cache = steps.find((step) => /provision:test-model-cache/u.test(step?.run ?? ''));
  assert.ok(cache, 'the host must provision the desktop test model cache when asked');
  assert.equal(
    String(cache.if ?? '')
      .replace(/^\$\{\{\s*/u, '')
      .replace(/\s*\}\}$/u, ''),
    "inputs.model-cache == 'true'",
    'the model cache step must run exactly when the caller asks for it'
  );
  assert.equal(
    cache.run.trim(),
    'xvfb-run --auto-servernum pnpm --filter @brainstrike/desktop provision:test-model-cache',
    'Electron downloads the model into its Cache Storage, so provisioning needs the X server too'
  );
}

function mutate(file, from, to) {
  const sources = runnableWorkflowSources();
  const original = sources.get(file);
  assert.ok(original, `${file} must be a runnable workflow`);
  const mutated = original.replace(from, to);
  assert.notEqual(mutated, original, `the control mutation did not apply to ${file}`);
  sources.set(file, mutated);
  return sources;
}

test('every runnable lane that runs desktop integration uses the shared host', () => {
  assertDesktopLanesUseTheHost();
});

test('every integration lane on the shared host runs under its X server', () => {
  assertHostLanesRunUnderItsDisplay();
});

test('the shared host installs the X server and provisions the model cache under it', () => {
  assertHostActionProvidesTheDisplayAndCache();
});

test('CONTROL: a Unit lane without the host step turns the guard red', () => {
  const sources = mutate(
    'test.yml',
    /uses: \.\/\.github\/actions\/linux-desktop-test-host\n/u,
    'uses: ./.github/actions/apt-drop-unused-sources\n'
  );
  assert.throws(() => assertDesktopLanesUseTheHost(sources), /no earlier `uses:/u);
});

test('CONTROL: a desktop Unit shard without xvfb-run turns the guard red', () => {
  const sources = mutate('test.yml', 'run: xvfb-run --auto-servernum node', 'run: node');
  assert.throws(() => assertDesktopLanesUseTheHost(sources), /must run under `xvfb-run/u);
});

test('CONTROL: xvfb-run for desktop rows only turns the host-lane guard red at rest', () => {
  // The shape that sent Unit (rest) to "Missing X server or $DISPLAY".
  const sources = mutate(
    'test.yml',
    /run: xvfb-run --auto-servernum node/gu,
    `run: ${'$'}{{ matrix.partition == 'desktop' && 'xvfb-run --auto-servernum' || '' }} node`
  );
  assertDesktopLanesUseTheHost(sources);
  assert.throws(
    () => assertHostLanesRunUnderItsDisplay(sources),
    /must run under `xvfb-run[\s\S]*test\.yml › unit-shard › Push and manual integration tests \[rest\]/u
  );
});

test('CONTROL: Nightly Coverage without xvfb-run turns the host-lane guard red', () => {
  const sources = mutate('nightly-coverage.yml', /\n {10}xvfb-run --auto-servernum\n/u, '\n');
  assert.throws(
    () => assertHostLanesRunUnderItsDisplay(sources),
    /must run under `xvfb-run[\s\S]*nightly-coverage\.yml › package-coverage › Run package shard coverage \[desktop\]/u
  );
});

test('CONTROL: the host-lane detector cannot pass by finding no lanes', () => {
  assert.throws(() => assertHostLanesRunUnderItsDisplay(new Map()), /detector go dark/u);
});

test('CONTROL: a model cache provisioned for the wrong partition turns the guard red', () => {
  const sources = mutate(
    'test.yml',
    `model-cache: ${'$'}{{ matrix.partition == 'desktop' }}`,
    `model-cache: ${'$'}{{ matrix.partition == 'agent' }}`
  );
  assert.throws(() => assertDesktopLanesUseTheHost(sources), /provision the desktop model cache/u);
});

test('CONTROL: a conditional host step turns the guard red', () => {
  const sources = mutate(
    'test.yml',
    /( {6}- name: Provision the Linux desktop test host\n)/u,
    "$1        if: matrix.partition == 'desktop'\n"
  );
  assert.throws(() => assertDesktopLanesUseTheHost(sources), /must not be conditional/u);
});

test('CONTROL: Nightly Coverage without the host step turns the guard red', () => {
  const sources = mutate(
    'nightly-coverage.yml',
    /uses: \.\/\.github\/actions\/linux-desktop-test-host\n/u,
    'uses: ./.github/actions/apt-drop-unused-sources\n'
  );
  assert.throws(() => assertDesktopLanesUseTheHost(sources), /nightly-coverage\.yml.*no earlier/u);
});

test('CONTROL: Nightly Coverage without xvfb-run turns the guard red', () => {
  const sources = mutate('nightly-coverage.yml', /\n {10}xvfb-run --auto-servernum\n/u, '\n');
  assert.throws(() => assertDesktopLanesUseTheHost(sources), /must run under `xvfb-run/u);
});

test('CONTROL: the detector cannot pass by finding no desktop lanes', () => {
  assert.throws(() => assertDesktopLanesUseTheHost(new Map()), /detector go dark/u);
});

test('CONTROL: a host without xvfb turns the host guard red', () => {
  const mutated = hostActionSource().replace(/ ripgrep xvfb\n/u, ' ripgrep\n');
  assert.notEqual(mutated, hostActionSource(), 'the control mutation did not apply');
  assert.throws(() => assertHostActionProvidesTheDisplayAndCache(mutated), /must install xvfb/u);
});

test('CONTROL: a model cache provisioned without an X server turns the host guard red', () => {
  const mutated = hostActionSource().replace(
    'run: xvfb-run --auto-servernum pnpm --filter',
    'run: pnpm --filter'
  );
  assert.notEqual(mutated, hostActionSource(), 'the control mutation did not apply');
  assert.throws(() => assertHostActionProvidesTheDisplayAndCache(mutated), /needs the X server/u);
});

test('the renderer refuses a matrix expression shape it does not know', () => {
  assert.throws(
    () => renderForRow(`${'$'}{{ matrix.partition != 'desktop' }}`, { partition: 'desktop' }),
    /unsupported matrix expression/u
  );
});

test('desktop selection follows turbo filter semantics', () => {
  const lane = 'pnpm turbo run test:integration';
  assert.equal(selectsDesktop(`${lane} --filter="@brainstrike/desktop"`), true);
  assert.equal(selectsDesktop(`${lane} --filter=@brainstrike/desktop...`), true);
  assert.equal(selectsDesktop(`${lane} --filter=...@brainstrike/agent`), true);
  assert.equal(selectsDesktop(`${lane} --filter="@brainstrike/ui"`), false);
  assert.equal(selectsDesktop(`${lane} --filter="!@brainstrike/db"`), true);
  assert.equal(
    selectsDesktop(`${lane} --filter="!@brainstrike/db" --filter="!@brainstrike/desktop"`),
    false
  );
  assert.equal(selectsDesktop(`${lane} --concurrency=2`), true);
  assert.equal(selectsDesktop('pnpm turbo run test:coverage:db:shard'), false);
  assert.equal(selectsDesktop('pnpm --filter @brainstrike/desktop test:integration'), true);
  assert.equal(selectsDesktop("pnpm --filter '!@brainstrike/desktop' -r test:integration"), false);
});
