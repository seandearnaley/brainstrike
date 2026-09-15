import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import desktopConfig from '../../apps/desktop/playwright.config.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRoot = path.join(repoRoot, 'apps/desktop');
const uploaders = [
  ['test.yml', 'desktop-e2e-smoke', 'Upload desktop smoke traces'],
  ['test.yml', 'desktop-e2e-delegated', 'Upload desktop delegated smoke traces'],
  ['test.yml', 'native-electron', 'Upload packaged MCP test diagnostics'],
  ['desktop-e2e.yml', 'desktop-full-regression', 'Upload desktop traces'],
  ['desktop-e2e.yml', 'desktop-embedding-e2e', 'Upload desktop embedding traces'],
];
const workflows = Object.fromEntries(
  [...new Set(uploaders.map(([workflow]) => workflow))].map((workflow) => [
    workflow,
    parseYaml(readFileSync(path.join(repoRoot, '.github/workflows', workflow), 'utf8')),
  ])
);

function assertDesktopArtifactPaths(config, workflowConfigs) {
  assert.equal(typeof config.outputDir, 'string', 'Desktop must declare its artifact directory');
  assert.ok(config.projects.length > 0, 'Desktop must declare its test projects');
  for (const [workflow, job, stepName] of uploaders) {
    const steps = workflowConfigs[workflow].jobs[job].steps;
    const upload = steps.find(({ name }) => name === stepName);
    assert.ok(upload, `${workflow}/${job} is missing ${stepName}`);
    assert.match(upload.if, /failure\(\)/u);
    assert.match(upload.uses, /^actions\/upload-artifact@/u);
    assert.equal(upload.with['if-no-files-found'], 'warn');
    for (const project of config.projects) {
      assert.equal(
        path.resolve(repoRoot, upload.with.path),
        path.resolve(desktopRoot, project.outputDir ?? config.outputDir),
        `${workflow}/${job} strands ${project.name} artifacts`
      );
    }
  }
}

// upload-artifact rejects a second artifact with the same name in one workflow
// run, so two parallel smoke lanes failing together would lose one lane's traces.
function assertDistinctArtifactNames(workflowConfigs) {
  const owners = new Map();
  for (const [workflow, job, stepName] of uploaders) {
    const upload = workflowConfigs[workflow].jobs[job].steps.find(({ name }) => name === stepName);
    const key = `${workflow}:${upload.with.name}`;
    assert.equal(
      owners.has(key),
      false,
      `${workflow}/${job} reuses artifact name ${upload.with.name} from ${owners.get(key)}`
    );
    owners.set(key, job);
  }
}

test('all desktop E2E uploaders collect the effective Playwright artifact directory', () => {
  assertDesktopArtifactPaths(desktopConfig, workflows);
  for (const [job, runStep, uploadStep] of [
    ['desktop-e2e-smoke', 'Run desktop smoke', 'Upload desktop smoke traces'],
    [
      'desktop-e2e-delegated',
      'Run desktop delegated smoke',
      'Upload desktop delegated smoke traces',
    ],
  ]) {
    const steps = workflows['test.yml'].jobs[job].steps;
    const smokeIndex = steps.findIndex(({ name }) => name === runStep);
    const uploadIndex = steps.findIndex(({ name }) => name === uploadStep);
    assert.ok(
      smokeIndex >= 0 && uploadIndex > smokeIndex,
      `${job} must upload after its smoke run`
    );
  }
  assertDistinctArtifactNames(workflows);
});

test('parallel uploaders sharing one artifact name fail the contract', () => {
  const changed = structuredClone(workflows);
  const upload = changed['test.yml'].jobs['desktop-e2e-delegated'].steps.find(
    ({ name }) => name === 'Upload desktop delegated smoke traces'
  );
  upload.with.name = changed['test.yml'].jobs['desktop-e2e-smoke'].steps.find(
    ({ name }) => name === 'Upload desktop smoke traces'
  ).with.name;
  assert.throws(() => assertDistinctArtifactNames(changed), /reuses artifact name/u);
});

test('changing the exported producer directory fails artifact coverage', () => {
  assert.throws(
    () =>
      assertDesktopArtifactPaths({ ...desktopConfig, outputDir: 'stranded-results' }, workflows),
    /strands smoke artifacts/u
  );
});

test('a project output override cannot silently strand its artifacts', () => {
  assert.throws(
    () =>
      assertDesktopArtifactPaths(
        {
          ...desktopConfig,
          projects: desktopConfig.projects.map((project) => ({
            ...project,
            outputDir: 'stranded-project',
          })),
        },
        workflows
      ),
    /strands smoke artifacts/u
  );
});

test('a sibling uploader reverting to test-results fails the same contract', () => {
  const changed = structuredClone(workflows);
  const upload = changed['desktop-e2e.yml'].jobs['desktop-embedding-e2e'].steps.find(
    ({ name }) => name === 'Upload desktop embedding traces'
  );
  upload.with.path = 'apps/desktop/test-results/';
  assert.throws(
    () => assertDesktopArtifactPaths(desktopConfig, changed),
    /strands smoke artifacts/u
  );
});
