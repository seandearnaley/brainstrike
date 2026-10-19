import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

// BST-2208: Playwright's blob reporter deletes its own outputDir before it
// writes the report zip, then skips every attachment file that no longer
// exists. With the desktop test outputDir set to the same blob-report/, each
// failure's trace.zip, screenshot, video and error-context were deleted before
// the zip was written, and hosted artifacts held only report.jsonl.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DESKTOP_DIR = path.join(REPO_ROOT, 'apps/desktop');
const DESKTOP_WORKFLOWS = ['.github/workflows/desktop-e2e.yml', '.github/workflows/test.yml'];

async function loadDesktopCiConfig() {
  // The reporter list depends on CI, so evaluate the config as hosted runs do.
  process.env.CI = 'true';
  const configUrl = pathToFileURL(path.join(DESKTOP_DIR, 'playwright.config.mts')).href;
  const { default: config } = await import(configUrl);
  return config;
}

// Playwright resolves a project's outputDir from the project, then the config,
// against the config's directory. Require the config to name it explicitly.
function testOutputDirs(config) {
  assert.equal(typeof config.outputDir, 'string', 'desktop config must declare outputDir');
  return config.projects.map((project) => ({
    dir: path.resolve(DESKTOP_DIR, project.outputDir ?? config.outputDir),
    project: project.name,
  }));
}

function blobReportDir(config) {
  const blob = config.reporter.find((entry) => Array.isArray(entry) && entry[0] === 'blob');
  assert.ok(blob, 'the desktop CI reporters must include the blob reporter');
  assert.equal(typeof blob[1]?.outputDir, 'string', 'the blob reporter must declare outputDir');
  return path.resolve(DESKTOP_DIR, blob[1].outputDir);
}

function isSameOrInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || !(relative.startsWith('..') || path.isAbsolute(relative));
}

function repoRelative(dir) {
  return path.relative(REPO_ROOT, dir);
}

function uploadPaths(step) {
  return String(step.with?.path ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/\/+$/u, ''))
    .filter(Boolean);
}

function runsDesktopPlaywright(step) {
  const run = String(step.run ?? '');
  if (step['working-directory'] === 'apps/desktop') {
    return /\bplaywright test\b|\btest:e2e:lane:/u.test(run);
  }
  return /--filter @brainstrike\/desktop run test:e2e:lane:/u.test(run);
}

test('desktop test output and the blob report live in separate directories', async () => {
  const config = await loadDesktopCiConfig();
  const blobDir = blobReportDir(config);

  for (const { dir, project } of testOutputDirs(config)) {
    assert.ok(
      !(isSameOrInside(blobDir, dir) || isSameOrInside(dir, blobDir)),
      `project ${project} writes test output to ${repoRelative(dir)}, which overlaps the blob ` +
        `reporter's ${repoRelative(blobDir)}: the blob reporter deletes that folder before ` +
        'it zips the attachments, so every trace, screenshot and error context is lost'
    );
  }
});

test('every desktop Playwright job uploads its test output and blob report on failure', async () => {
  const config = await loadDesktopCiConfig();
  const required = [
    ...new Set(testOutputDirs(config).map(({ dir }) => repoRelative(dir))),
    repoRelative(blobReportDir(config)),
  ];
  const checkedJobs = new Set();

  for (const workflowPath of DESKTOP_WORKFLOWS) {
    const workflow = parseYaml(readFileSync(path.join(REPO_ROOT, workflowPath), 'utf8'));
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      if (!steps.some(runsDesktopPlaywright)) {
        continue;
      }
      checkedJobs.add(`${path.basename(workflowPath)}:${jobId}`);
      const uploads = steps.filter(
        (step) =>
          String(step.uses).startsWith('actions/upload-artifact@') &&
          /\bfailure\(\)/u.test(String(step.if))
      );
      assert.ok(
        uploads.some((step) => required.every((dir) => uploadPaths(step).includes(dir))),
        `${workflowPath} job ${jobId} must upload ${required.join(' and ')} in one ` +
          `failure-only artifact; found: ${JSON.stringify(uploads.map(uploadPaths))}`
      );
    }
  }

  for (const job of [
    'desktop-e2e.yml:desktop-full-regression',
    'desktop-e2e.yml:desktop-embedding-e2e',
    'desktop-e2e.yml:desktop-foreground-latency',
    'test.yml:native-electron',
    'test.yml:desktop-e2e-smoke',
    'test.yml:desktop-e2e-delegated',
  ]) {
    assert.ok(checkedJobs.has(job), `the desktop Playwright job scan no longer sees ${job}`);
  }
});
