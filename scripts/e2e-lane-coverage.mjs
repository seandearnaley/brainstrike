#!/usr/bin/env node
// BST-1010 (R09): static lane-coverage contract for the Playwright E2E suites.
//
// The "specs running nowhere" class (BST-891/816/817) is not an affected-test
// selection bug — it is a lane wiring gap, computable from source with no suite
// run at all. Two live instances on `main` when this guard landed:
//
//   - apps/web/e2e/workspace-index-background-indexing.test.ts carried
//     `@web-indexing`, a tag NO lane greps, on a `@stateful` describe — and
//     `@stateful` is grep-inverted out of full-regression's broad pass. The tag
//     rescued nothing.
//   - apps/web/e2e/production-csp.test.ts carried `@stateful` and no lane tag at
//     all, and appeared in zero lane file lists.
//
// Both were excluded from the broad pass and rescued by no lane, so they ran in
// no CI job. A full-vs-affected suite diff would not have caught either.
//
// The model is deliberately exact rather than heuristic: lane selection is
// reconstructed from the real Playwright semantics (explicit file list, project
// `grep`/`grepInvert`, command-line `--grep`/`--grep-invert`) and applied to the
// real title paths parsed out of each spec's AST. Anything it cannot model
// statically THROWS instead of being assumed benign.
//
// WHAT A GREEN HERE DOES *NOT* PROVE — read this before citing it.
// This guard proves STATIC reachability: every spec is named by, or tagged into,
// some lane that CI invokes. It says nothing about whether a spec actually RAN.
// `test:e2e:lane:full-regression` is an `&&`-SEQUENTIAL chain (a broad pass then
// N named lanes), so any lane that fails short-circuits every lane after it, and
// those specs silently do not execute — the BST-1032 blind-window class. A spec
// appended to the end of that chain is "covered" by this guard while never
// running for weeks. Solving the dynamic problem needs a run-artifact diff and is
// deliberately out of scope. What this guard does add against the chain risk is
// the `uninvoked-lane` check below: a lane that no CI entrypoint reaches at all
// (directly or through a chain) cannot silently supply coverage here.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { listPlaywrightTitleEntries, listTestFiles } from './e2e-playwright-title-tags.mjs';

const SPEC_FILE_PATTERN = /\.test\.[cm]?[tj]sx?$/;

// Directories under an app's `e2e/` that hold no lane-managed spec.
//
// Both exclusions are FACTS OF THE PLAYWRIGHT CONFIG, not conveniences:
//   - `__tests__` is in both configs' `testIgnore`, so Playwright never loads it
//     (apps/web/e2e/page-objects/__tests__ holds Vitest unit tests).
//   - web's `performance` dir cannot be selected by the `functional`/`smoke`
//     projects at all — their testMatch is `**/!(performance)/*.test.ts`. Those
//     specs belong to the `performance` project, which `performance.yml` drives
//     directly (`--project="$PERF_PROJECT"`), not through any lane script.
//
// `e2e-lane-coverage.test.mjs` re-asserts both facts against the config sources,
// so a config change that invalidates an exclusion fails rather than silently
// shrinking the sweep.
const EXCLUDED_SPEC_DIRS = {
  desktop: ['__tests__'],
  web: ['__tests__', 'performance'],
};

/**
 * Project-level `grep`/`grepInvert` from each app's playwright.config.ts.
 *
 * Only `desktop:regression` changes any verdict today (its `grepInvert: /@smoke/`
 * means a `@smoke`-titled desktop spec absent from the smoke lane's file list
 * runs NOWHERE), but every project a lane targets must be modelled: an
 * unmodelled `--project=` throws rather than defaulting to "no filter", which
 * would silently over-report reachability.
 */
const PLAYWRIGHT_PROJECT_FILTERS = {
  'desktop:regression': { grepInvert: /@smoke/ },
  'desktop:smoke': { grep: /@smoke/ },
  'web:functional': {},
  'web:smoke': { grep: /@smoke/ },
};

/**
 * Workflows scanned for lane commands written inline instead of as a package
 * script. `desktop-e2e.yml` is the one that matters: its `desktop-embedding-e2e`
 * job runs the `@desktop-embedding-*` specs with a hand-written playwright
 * invocation, and those specs are grep-inverted out of
 * `test:e2e:lane:full-regression`.
 *
 * The list is explicit, and that is the SAFE direction: a new inline lane in an
 * unlisted workflow makes this guard report its specs as unreachable (loud red),
 * never the reverse. Scanning every workflow would be the unsafe direction —
 * `local-desktop-e2e.yml` is a `workflow_dispatch`-only whole-suite shard run, so
 * counting it would mark every desktop spec reachable and make the sweep
 * vacuous.
 */
const LANE_WORKFLOW_FILES = ['desktop-e2e.yml', 'test.yml', 'web-e2e.yml'];

/**
 * Anti-vacuity floors. Without these, a rename of `e2e/`, a change to the lane
 * script naming convention, or a broken glob turns the whole sweep into a no-op
 * that passes forever.
 */
const MINIMUMS = {
  desktop: { lanes: 3, laneTags: 12, specs: 35 },
  web: { lanes: 8, laneTags: 8, specs: 30 },
};

/**
 * Specs known to run nowhere whose fix is out of this guard's reach. Entries are
 * SELF-CLEANING: a listed spec that is actually reachable, or that no longer
 * exists, fails the guard. An exemption cannot rot into a permanent hole.
 */
const KNOWN_UNREACHABLE_SPECS = {
  'apps/desktop/e2e/embedding-worker-renderer.crash-b.desktop.test.ts':
    'Pre-existing orphan found by this guard (BST-1010). The desktop embedding ' +
    'lane is written inline in .github/workflows/desktop-e2e.yml and its file list ' +
    'names crash-a but not crash-b, while test:e2e:lane:full-regression ' +
    'grep-inverts @desktop-embedding-. The fix is a one-line workflow edit, ' +
    'deliberately out of scope for the PR that introduced this guard. Delete this ' +
    'entry together with that fix.',
};

const APP_DIRECTORIES = { desktop: 'apps/desktop', web: 'apps/web' };
const APP_TAG_PREFIXES = { desktop: '@desktop-', web: '@web-' };
const LANE_SCRIPT_PREFIX = 'test:e2e:lane:';

function toPosix(value) {
  return value.split(path.sep).join('/');
}

/** Split on top-level `&&`, `;` and newlines, ignoring separators inside quotes. */
function splitCommandSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      current += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '&' && command[index + 1] === '&') {
      segments.push(current);
      current = '';
      index += 1;
      continue;
    }
    if (character === ';' || character === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

function tokenize(segment, origin) {
  const tokens = [];
  let current = '';
  let started = false;
  let quote = null;

  for (const character of segment) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
      }
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (quote) {
    throw new Error(`${origin}: unterminated quote in playwright command: ${segment}`);
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

function readFlagValue(tokens, index, flag, origin) {
  const token = tokens[index];
  if (token === flag) {
    const value = tokens[index + 1];
    if (value === undefined) {
      throw new Error(`${origin}: ${flag} has no value`);
    }
    return { consumed: 2, value };
  }
  return { consumed: 1, value: token.slice(flag.length + 1) };
}

function matchesFlag(token, flag) {
  return token === flag || token.startsWith(`${flag}=`);
}

/**
 * Reconstruct one playwright invocation's selector. Returns null when the
 * segment is not a playwright run (a `pnpm run test:e2e:lane:x` link in a chain,
 * an `unset NO_COLOR` line, an install step).
 */
function parsePlaywrightInvocation(segment, origin) {
  const tokens = tokenize(segment, origin);
  const playwrightIndex = tokens.findIndex(
    (token, index) =>
      (token === 'playwright' || token.endsWith('/playwright')) && tokens[index + 1] === 'test'
  );
  if (playwrightIndex === -1) {
    return null;
  }

  const invocation = { files: [], grep: null, grepInvert: null, origin, project: null };

  for (let index = playwrightIndex + 2; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (matchesFlag(token, '--project')) {
      const { consumed, value } = readFlagValue(tokens, index, '--project', origin);
      invocation.project = value;
      index += consumed - 1;
      continue;
    }
    if (matchesFlag(token, '--grep-invert')) {
      const { consumed, value } = readFlagValue(tokens, index, '--grep-invert', origin);
      invocation.grepInvert = new RegExp(value);
      index += consumed - 1;
      continue;
    }
    if (matchesFlag(token, '--grep') || token === '-g') {
      const flag = token === '-g' ? '-g' : '--grep';
      const { consumed, value } = readFlagValue(tokens, index, flag, origin);
      invocation.grep = new RegExp(value);
      index += consumed - 1;
      continue;
    }
    if (token.startsWith('-')) {
      // Every other flag this repo passes is written in `--flag=value` form, so
      // it consumes no following token. A bare `--flag value` would make the
      // value look like a positional; the positional check below rejects
      // anything that is not a spec path rather than guessing.
      if (!(token.includes('=') || /^--(debug|headed|list|ui|update-snapshots)$/.test(token))) {
        throw new Error(
          `${origin}: unmodelled playwright flag "${token}" written without "=". Teach ` +
            'parsePlaywrightInvocation whether it consumes the next token.'
        );
      }
      continue;
    }
    if (!SPEC_FILE_PATTERN.test(token)) {
      throw new Error(
        `${origin}: unmodelled positional argument "${token}" after \`playwright test\`.`
      );
    }
    invocation.files.push(token);
  }

  if (invocation.project === null) {
    throw new Error(
      `${origin}: playwright invocation has no --project, so which project filters apply is ` +
        'undecidable. Add --project or teach this guard the config default.'
    );
  }
  return invocation;
}

/** Lane scripts a command chain hands off to (`pnpm run test:e2e:lane:x`). */
function findLaneScriptReferences(command) {
  const references = new Set();
  for (const segment of splitCommandSegments(command)) {
    for (const token of tokenize(segment, 'lane-reference scan')) {
      if (token.startsWith(LANE_SCRIPT_PREFIX)) {
        references.add(token);
      }
    }
  }
  return references;
}

function collectPackageScriptLanes(app, packageJson) {
  const lanes = [];
  const laneScripts = new Map();
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    if (!name.startsWith(LANE_SCRIPT_PREFIX)) {
      continue;
    }
    laneScripts.set(name, command);
    for (const segment of splitCommandSegments(command)) {
      const invocation = parsePlaywrightInvocation(segment, `${APP_DIRECTORIES[app]}#${name}`);
      if (invocation) {
        lanes.push({ ...invocation, app, name, scriptName: name });
      }
    }
  }
  return { laneScripts, lanes };
}

function stepWorkingDirectory(workflow, job, step) {
  return (
    step['working-directory'] ??
    job.defaults?.run?.['working-directory'] ??
    workflow.defaults?.run?.['working-directory'] ??
    null
  );
}

/**
 * Which app a workflow step acts on: an explicit `--filter @brainstrike/<app>`
 * wins, otherwise the step's working directory. Neither present is a hard error
 * — guessing would silently attribute a lane to the wrong app.
 */
function resolveStepApp({ appPackageNames, origin, tokens, workingDirectory }) {
  const filterIndex = tokens.indexOf('--filter');
  const filterValue = filterIndex === -1 ? null : tokens[filterIndex + 1];
  if (filterValue && appPackageNames.has(filterValue)) {
    return appPackageNames.get(filterValue);
  }
  const byDirectory = Object.entries(APP_DIRECTORIES).find(
    ([, directory]) => directory === workingDirectory
  )?.[0];
  if (byDirectory) {
    return byDirectory;
  }
  throw new Error(
    `${origin}: cannot tell which app this E2E step targets (working-directory ` +
      `"${workingDirectory ?? '<repo root>'}", no recognised --filter).`
  );
}

function collectWorkflowEntrypoints(workflowFile, workflow, appPackageNames) {
  const lanes = [];
  const invokedLaneScripts = [];

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== 'string') {
        continue;
      }
      // A trailing backslash continues the command onto the next line.
      const command = step.run.replace(/\\\n/g, ' ');
      const origin = `.github/workflows/${workflowFile} ${jobName}/${step.name ?? 'run'}`;
      const workingDirectory = stepWorkingDirectory(workflow, job, step);

      for (const segment of splitCommandSegments(command)) {
        const tokens = tokenize(segment, origin);
        const invocation = parsePlaywrightInvocation(segment, origin);
        if (invocation) {
          const app = resolveStepApp({ appPackageNames, origin, tokens, workingDirectory });
          lanes.push({
            ...invocation,
            app,
            ciInvoked: true,
            name: `${workflowFile}:${jobName}`,
            scriptName: null,
          });
          continue;
        }
        for (const token of tokens) {
          if (token.startsWith(LANE_SCRIPT_PREFIX)) {
            const app = resolveStepApp({ appPackageNames, origin, tokens, workingDirectory });
            invokedLaneScripts.push({ app, origin, scriptName: token });
          }
        }
      }
    }
  }
  return { invokedLaneScripts, lanes };
}

function selectsTitle(lane, specRelativeToApp, titlePath) {
  if (lane.files.length > 0 && !lane.files.includes(specRelativeToApp)) {
    return false;
  }
  const projectKey = `${lane.app}:${lane.project}`;
  const projectFilter = PLAYWRIGHT_PROJECT_FILTERS[projectKey];
  if (!projectFilter) {
    throw new Error(
      `${lane.name}: targets --project=${lane.project}, which is absent from ` +
        `PLAYWRIGHT_PROJECT_FILTERS (looked up "${projectKey}"). Model its grep/grepInvert.`
    );
  }
  if (projectFilter.grep && !projectFilter.grep.test(titlePath)) {
    return false;
  }
  if (projectFilter.grepInvert?.test(titlePath)) {
    return false;
  }
  if (lane.grep && !lane.grep.test(titlePath)) {
    return false;
  }
  if (lane.grepInvert?.test(titlePath)) {
    return false;
  }
  return true;
}

function isExcludedSpec(app, specRelativeToApp) {
  const segments = specRelativeToApp.split('/');
  return EXCLUDED_SPEC_DIRS[app].some((directory) => segments.includes(directory));
}

async function collectSpecs(app, appRoot, repoRoot) {
  const e2eDir = path.join(appRoot, 'e2e');
  const specs = [];
  for (const file of (await listTestFiles(e2eDir)).sort()) {
    const relativeToApp = toPosix(path.relative(appRoot, file));
    if (isExcludedSpec(app, relativeToApp)) {
      continue;
    }
    const source = await readFile(file, 'utf8');
    const titlePaths = listPlaywrightTitleEntries(source, file)
      .filter((entry) => entry.kind === 'test')
      .map((entry) => entry.titlePath);
    specs.push({
      relativeToApp,
      relativeToRepo: toPosix(path.relative(repoRoot, file)),
      titlePaths,
    });
  }
  return specs;
}

function assertFloor(actual, minimum, subject) {
  if (actual < minimum) {
    throw new Error(
      `Anti-vacuity floor: found ${actual} ${subject}, below the floor of ${minimum}. Either ` +
        'they were deleted (restore them) or discovery broke, in which case every assertion ' +
        'in this guard is vacuously green.'
    );
  }
}

/** Lane scripts a CI entrypoint reaches, directly or through an `&&` chain. */
function resolveCiInvokedLaneScripts(laneScripts, directlyInvoked) {
  const reached = new Set();
  const queue = [...directlyInvoked];
  while (queue.length > 0) {
    const name = queue.pop();
    if (reached.has(name)) {
      continue;
    }
    reached.add(name);
    const command = laneScripts.get(name);
    if (command === undefined) {
      continue;
    }
    for (const reference of findLaneScriptReferences(command)) {
      if (reference !== name) {
        queue.push(reference);
      }
    }
  }
  return reached;
}

/**
 * `minimums` and `knownUnreachableSpecs` are injectable so the paired test can
 * drive this against a miniature fixture repo. Production callers pass neither —
 * the CLI always runs with the real floors and the real exemption list.
 */
export async function analyzeE2eLaneCoverage({
  knownUnreachableSpecs = KNOWN_UNREACHABLE_SPECS,
  minimums: minimumsByApp = MINIMUMS,
  repoRoot,
}) {
  const lanesByApp = { desktop: [], web: [] };
  const laneScriptsByApp = { desktop: new Map(), web: new Map() };
  const appPackageNames = new Map();

  for (const [app, directory] of Object.entries(APP_DIRECTORIES)) {
    const manifestPath = path.join(repoRoot, directory, 'package.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`Missing ${directory}/package.json under ${repoRoot}; nothing to check.`);
    }
    const packageJson = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof packageJson.name === 'string') {
      appPackageNames.set(packageJson.name, app);
    }
    const { laneScripts, lanes } = collectPackageScriptLanes(app, packageJson);
    laneScriptsByApp[app] = laneScripts;
    lanesByApp[app].push(...lanes);
  }

  const directlyInvokedByApp = { desktop: new Set(), web: new Set() };
  for (const workflowFile of LANE_WORKFLOW_FILES) {
    const workflowPath = path.join(repoRoot, '.github/workflows', workflowFile);
    if (!existsSync(workflowPath)) {
      continue;
    }
    const workflow = parseYaml(await readFile(workflowPath, 'utf8'));
    const { invokedLaneScripts, lanes } = collectWorkflowEntrypoints(
      workflowFile,
      workflow,
      appPackageNames
    );
    for (const lane of lanes) {
      lanesByApp[lane.app].push(lane);
    }
    for (const { app, scriptName } of invokedLaneScripts) {
      directlyInvokedByApp[app].add(scriptName);
    }
  }

  const apps = [];
  const violations = [];
  const exemptions = [];

  for (const [app, directory] of Object.entries(APP_DIRECTORIES)) {
    const appRoot = path.join(repoRoot, directory);
    const allLanes = lanesByApp[app];
    const allSpecs = await collectSpecs(app, appRoot, repoRoot);

    const ciInvokedScripts = resolveCiInvokedLaneScripts(
      laneScriptsByApp[app],
      directlyInvokedByApp[app]
    );
    for (const lane of allLanes) {
      lane.ciInvoked = lane.scriptName === null || ciInvokedScripts.has(lane.scriptName);
    }
    // Only CI-invoked lanes may supply coverage. A dev-convenience lane script
    // no workflow reaches must not be able to mark a spec as covered.
    const lanes = allLanes.filter((lane) => lane.ciInvoked);

    const minimums = minimumsByApp[app];
    assertFloor(lanes.length, minimums.lanes, `${app} CI-invoked E2E lane invocation(s)`);
    assertFloor(allSpecs.length, minimums.specs, `${app} E2E spec file(s)`);

    const unreachable = new Set(
      allSpecs
        .filter(
          (spec) =>
            !spec.titlePaths.some((titlePath) =>
              lanes.some((lane) => selectsTitle(lane, spec.relativeToApp, titlePath))
            )
        )
        .map((spec) => spec.relativeToRepo)
    );

    // Self-cleaning exemptions, checked BEFORE they are applied.
    const appExemptions = Object.entries(knownUnreachableSpecs).filter(([specPath]) =>
      specPath.startsWith(`${directory}/`)
    );
    for (const [specPath, reason] of appExemptions) {
      if (!allSpecs.some((spec) => spec.relativeToRepo === specPath)) {
        violations.push({
          app,
          detail: `${specPath} is exempted in KNOWN_UNREACHABLE_SPECS but is not a spec in the swept universe. Delete the stale entry.`,
          kind: 'stale-exemption',
        });
        continue;
      }
      if (!unreachable.has(specPath)) {
        violations.push({
          app,
          detail: `${specPath} is exempted in KNOWN_UNREACHABLE_SPECS but is now reachable from a lane. Delete the entry — the exemption is no longer true.`,
          kind: 'stale-exemption',
        });
        continue;
      }
      exemptions.push({ app, reason, spec: specPath });
    }
    const exemptedSpecs = new Set(exemptions.map((exemption) => exemption.spec));
    const specs = allSpecs.filter((spec) => !exemptedSpecs.has(spec.relativeToRepo));

    // Assertion 1: every lane-shaped tag routes at least one title somewhere.
    const tagPrefix = APP_TAG_PREFIXES[app];
    const titlePathsByTag = new Map();
    for (const spec of specs) {
      for (const titlePath of spec.titlePaths) {
        for (const match of titlePath.matchAll(/@[\w-]+/g)) {
          if (!match[0].startsWith(tagPrefix)) {
            continue;
          }
          const existing = titlePathsByTag.get(match[0]) ?? [];
          existing.push({ spec, titlePath });
          titlePathsByTag.set(match[0], existing);
        }
      }
    }
    assertFloor(titlePathsByTag.size, minimums.laneTags, `distinct ${tagPrefix}* lane tag(s)`);

    for (const [tag, carriers] of [...titlePathsByTag.entries()].sort()) {
      const routed = carriers.some(({ spec, titlePath }) =>
        lanes.some((lane) => selectsTitle(lane, spec.relativeToApp, titlePath))
      );
      if (!routed) {
        violations.push({
          app,
          detail:
            `${tag} is carried by ${carriers.length} title(s) but no lane selects any of them, ` +
            `so the tag routes nothing: ${[...new Set(carriers.map(({ spec }) => spec.relativeToRepo))].join(', ')}`,
          kind: 'orphan-tag',
        });
      }
    }

    // Assertion 2: every spec is reachable from at least one lane.
    for (const spec of specs) {
      if (spec.titlePaths.length === 0) {
        violations.push({
          app,
          detail: `${spec.relativeToRepo} declares no Playwright test titles, so no lane can run it.`,
          kind: 'orphan-spec',
        });
        continue;
      }
      if (unreachable.has(spec.relativeToRepo)) {
        violations.push({
          app,
          detail:
            `${spec.relativeToRepo} is selected by NO lane: it is in no lane's explicit file ` +
            'list, carries no tag a lane greps, and every one of its titles is filtered out of ' +
            'the broad passes.',
          kind: 'orphan-spec',
        });
      }
    }

    // Assertion 3: every lane's explicit file list names files that exist, and
    // no lane selects zero tests. Checked over ALL lanes, invoked or not — a
    // dangling path in a dev lane is the same rename bug.
    for (const lane of allLanes) {
      for (const file of lane.files) {
        if (!existsSync(path.join(appRoot, file))) {
          violations.push({
            app,
            detail: `${lane.name} names "${file}", which does not exist under ${directory}/. Renamed or deleted?`,
            kind: 'missing-lane-file',
          });
        }
      }
      const selectsAnything = allSpecs.some((spec) =>
        spec.titlePaths.some((titlePath) => selectsTitle(lane, spec.relativeToApp, titlePath))
      );
      if (!selectsAnything) {
        violations.push({
          app,
          detail: `${lane.name} selects zero tests — its file list, project filter and grep no longer intersect any spec.`,
          kind: 'empty-lane',
        });
      }
    }

    apps.push({
      app,
      laneNames: lanes.map((lane) => lane.name).sort(),
      laneTagCount: titlePathsByTag.size,
      specCount: allSpecs.length,
      uninvokedLaneNames: allLanes
        .filter((lane) => !lane.ciInvoked)
        .map((lane) => lane.name)
        .sort(),
    });
  }

  return { apps, exemptions, violations };
}

export function formatReport(report) {
  const lines = [];
  for (const app of report.apps) {
    lines.push(
      `${app.app}: examined ${app.specCount} spec file(s), ${app.laneNames.length} CI-invoked lane invocation(s), ${app.laneTagCount} lane tag(s)`
    );
    for (const laneName of app.laneNames) {
      lines.push(`    lane: ${laneName}`);
    }
    for (const laneName of app.uninvokedLaneNames) {
      lines.push(`    lane (NOT reached by any CI entrypoint, supplies no coverage): ${laneName}`);
    }
  }
  for (const exemption of report.exemptions) {
    lines.push(`KNOWN UNREACHABLE (exempted): ${exemption.spec}`);
    lines.push(`    ${exemption.reason}`);
  }
  if (report.violations.length === 0) {
    lines.push('E2E lane coverage check passed.');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('E2E lane coverage check FAILED.');
  lines.push(
    'Every E2E spec must run in some lane. A spec excluded from the broad pass and rescued by ' +
      'no lane runs in no CI job at all (BST-891/816/817).'
  );
  for (const violation of report.violations) {
    lines.push(`- [${violation.kind}] ${violation.app}: ${violation.detail}`);
  }
  return lines.join('\n');
}

export async function main({ logger = console, repoRoot = process.cwd(), ...options } = {}) {
  const report = await analyzeE2eLaneCoverage({ ...options, repoRoot });
  const text = formatReport(report);
  if (report.violations.length > 0) {
    logger.error(text);
    process.exitCode = 1;
    return report;
  }
  logger.log(text);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
