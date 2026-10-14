// Contract guard for the vitest event-loop watchdog (BST-1221).
//
// Every lane that hosts real PGlite must list
// `@brainstrike/test-utils/vitest.event-loop-watchdog.setup` FIRST in its
// `setupFiles`: first because the watchdog's heartbeat interval is captured at
// module evaluation and must be a real timer, ahead of any setup that could
// install fake timers. A lane that forgets it reintroduces the silent
// 30-minute hang the watchdog exists to kill; a lane that lists it second can
// be disarmed by whatever loaded before it. The lane list below IS the
// contract (docs/agents/ci-quality.md, "A worker with a blocked event loop is
// killed and named"): adding a PGlite-hosting lane means adding it here.
//
// Like verify-lost-file-reporter.mjs this LOADS each config and inspects the
// effective `setupFiles` rather than grepping source text, so an unused
// import, a comment, or a second-position entry cannot satisfy it.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const WATCHDOG_SETUP_ID = '@brainstrike/test-utils/vitest.event-loop-watchdog.setup';

/**
 * The PGlite-hosting lanes. `project` names an inline vitest project whose
 * own `setupFiles` carry the guarantee; without it the config's top-level
 * `test.setupFiles` is checked.
 */
export const PGLITE_LANES = Object.freeze([
  { config: 'apps/desktop/vitest.config.mts' },
  { config: 'apps/desktop/vitest.integration.config.mts' },
  { config: 'packages/agent/vitest.config.mts' },
  { config: 'packages/agent/vitest.integration.config.mts' },
  { config: 'packages/app-shell/vitest.config.mts' },
  { config: 'packages/app-shell/vitest.integration.config.mts' },
  { config: 'packages/assistant-data/vitest.config.mts' },
  { config: 'packages/assistant-data/vitest.integration.config.mts' },
  { config: 'packages/assistant-service/vitest.config.mts' },
  { config: 'packages/db/vitest.config.mts', project: 'unit' },
  { config: 'packages/db-explorer/vitest.config.mts' },
  { config: 'packages/db-explorer/vitest.integration.config.mts' },
  { config: 'packages/embeddings/vitest.config.mts' },
  { config: 'packages/embeddings/vitest.integration.config.mts' },
  { config: 'packages/file-import/vitest.config.mts' },
  { config: 'packages/file-import/vitest.integration.config.mts' },
  { config: 'packages/settings-ui/vitest.config.mts' },
  { config: 'packages/settings-ui/vitest.integration.config.mts' },
]);

/** A shrunken lane list means the contract was edited, not that fewer lanes host PGlite. */
export const MIN_LANES = 18;

function isWatchdogSetup(setupFile, configPath) {
  if (setupFile === WATCHDOG_SETUP_ID) {
    return true;
  }
  if (typeof setupFile !== 'string' || configPath === undefined) {
    return false;
  }
  const resolveModule = createRequire(configPath).resolve;
  try {
    return resolveModule(setupFile) === resolveModule(WATCHDOG_SETUP_ID);
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') {
      return false;
    }
    throw error;
  }
}

/** True only when the watchdog module is the FIRST effective setup file. */
export function leadsWithWatchdog(setupFiles, configPath) {
  const first = Array.isArray(setupFiles) ? setupFiles[0] : setupFiles;
  return isWatchdogSetup(first, configPath);
}

/** The `setupFiles` vitest would use for this config (or one of its inline projects). */
export async function loadEffectiveSetupFiles(configPath, projectName) {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, configPath);
  if (!loaded?.config) {
    throw new Error(`verify-event-loop-watchdog: vite could not load ${configPath}`);
  }
  const test = loaded.config.test;
  if (projectName === undefined) {
    if (Array.isArray(test?.projects) && test.projects.length > 0) {
      throw new Error(
        `verify-event-loop-watchdog: ${configPath} declares projects; name the project ` +
          'in the lane contract instead of checking top-level setupFiles.'
      );
    }
    return test?.setupFiles;
  }
  const projects = test?.projects;
  if (!Array.isArray(projects)) {
    throw new Error(
      `verify-event-loop-watchdog: ${configPath} declares no inline projects, but the lane ` +
        `contract names project "${projectName}".`
    );
  }
  const project = projects.find(
    (candidate) =>
      candidate !== null && typeof candidate === 'object' && candidate.test?.name === projectName
  );
  if (!project) {
    throw new Error(
      `verify-event-loop-watchdog: ${configPath} has no inline project named "${projectName}".`
    );
  }
  return project.test.setupFiles;
}

function describeSetupFiles(setupFiles, configPath) {
  if (setupFiles === undefined) {
    return 'no setupFiles';
  }
  if (typeof setupFiles === 'string') {
    return `setupFiles omits the watchdog: ${JSON.stringify(setupFiles)}`;
  }
  if (!Array.isArray(setupFiles)) {
    return `setupFiles is ${typeof setupFiles}, not a string or array`;
  }
  const position = setupFiles.findIndex((setupFile) => isWatchdogSetup(setupFile, configPath));
  if (position === -1) {
    return `setupFiles omits the watchdog: ${JSON.stringify(setupFiles)}`;
  }
  return `watchdog listed at position ${position + 1}, not first: ${JSON.stringify(setupFiles)}`;
}

/** Lanes whose effective setupFiles do not lead with the watchdog. */
export async function findLanesMissingWatchdog(repoRoot, lanes) {
  const missing = [];
  for (const lane of lanes) {
    const configPath = resolve(repoRoot, lane.config);
    if (!existsSync(configPath)) {
      missing.push({ ...lane, reason: 'config file does not exist' });
      continue;
    }
    try {
      const setupFiles = await loadEffectiveSetupFiles(configPath, lane.project);
      if (!leadsWithWatchdog(setupFiles, configPath)) {
        missing.push({ ...lane, reason: describeSetupFiles(setupFiles, configPath) });
      }
    } catch (error) {
      missing.push({
        ...lane,
        reason: `config failed to load: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return missing;
}

function laneLabel(lane) {
  return lane.project ? `${lane.config} (project "${lane.project}")` : lane.config;
}

export async function main({ repoRoot = REPO_ROOT, lanes = PGLITE_LANES } = {}) {
  if (lanes.length < MIN_LANES) {
    throw new Error(
      `verify-event-loop-watchdog: the lane contract lists only ${lanes.length} PGlite-hosting ` +
        `lane(s), below the floor of ${MIN_LANES}. Lanes are added, not removed; if one really ` +
        'stopped hosting PGlite, lower the floor deliberately in the same change.'
    );
  }
  const missing = await findLanesMissingWatchdog(repoRoot, lanes);
  if (missing.length > 0) {
    throw new Error(
      `verify-event-loop-watchdog: ${missing.length} PGlite-hosting lane(s) do not list the ` +
        'event-loop watchdog setup FIRST, so a blocked worker there hangs silently for the ' +
        'whole job instead of being killed and named (BST-1221):\n' +
        `${missing.map((lane) => `  - ${laneLabel(lane)}: ${lane.reason}`).join('\n')}\n\n` +
        "Put this as the FIRST entry of that lane's `setupFiles`:\n" +
        `  '${WATCHDOG_SETUP_ID}',\n`
    );
  }
  return (
    `verify-event-loop-watchdog: OK (${lanes.length} PGlite-hosting lanes lead their setupFiles ` +
    'with the event-loop watchdog)\n'
  );
}

if (import.meta.main) {
  process.stdout.write(await main());
}
