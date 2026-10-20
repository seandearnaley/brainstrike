// BST-2181: real-process and Electron integration tests poll with expect.poll,
// and a call without options used Vitest's 1 s default. The lanes that run
// them set Vitest's own `test.expect.poll` default instead. This loads each
// lane's config and reads the poll default each project's workers receive.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createVitest } from 'vitest/node';
import desktopBase, { resolveDesktopTestProjects } from '../../apps/desktop/vitest.config.mts';
import { createDesktopUnitConfig } from '../../apps/desktop/vitest.unit.config.mts';
import { getExpectPollTimeout } from '../../packages/test-utils/src/test-timeouts.ts';
import { withVitestModuleCache } from './helpers/vitest-module-cache.mjs';

/** The `expect.poll` default and test timeout of every project a config resolves. */
async function resolvePollDefaults(options, viteConfig) {
  return withVitestModuleCache(async (fsModuleCachePath) => {
    const vitest = await createVitest(
      'test',
      { ...options, fsModuleCachePath, watch: false },
      viteConfig
    );
    try {
      return vitest.projects.map((project) => ({
        name: project.name,
        poll: project.serializedConfig.expect?.poll,
        testTimeout: project.config.testTimeout,
      }));
    } finally {
      await vitest.close();
    }
  });
}

function assertPollDefault(lane, projects) {
  assert.ok(projects.length > 0, `${lane} must resolve a project`);
  for (const { name, poll, testTimeout } of projects) {
    const project = `${lane}${name ? ` (${name})` : ''}`;
    assert.equal(poll?.timeout, getExpectPollTimeout(), `${project} expect.poll timeout`);
    // The poll's own error must surface before the test times out.
    assert.ok(poll.timeout < testTimeout, `${project}: ${poll.timeout} ms poll >= ${testTimeout}`);
  }
}

const fileConfig = (file) => ({ config: path.resolve(file) });

test('desktop coverage, integration and unit lanes default expect.poll to the scaled budget', async () => {
  // Coverage runs the base config with the full include.
  assertPollDefault(
    'desktop coverage',
    await resolvePollDefaults(fileConfig('apps/desktop/vitest.config.mts'))
  );
  assertPollDefault(
    'desktop coverage on Windows',
    await resolvePollDefaults(
      { config: false },
      {
        ...desktopBase,
        test: { ...desktopBase.test, projects: resolveDesktopTestProjects('win32') },
      }
    )
  );
  assertPollDefault(
    'desktop integration',
    await resolvePollDefaults(fileConfig('apps/desktop/vitest.integration.config.mts'))
  );
  for (const [branch, options] of [
    ['parallel', { cores: 16, environment: {}, platform: 'linux' }],
    ['CI', { environment: { CI: 'true' }, platform: 'linux' }],
    ['Windows', { environment: {}, platform: 'win32' }],
  ]) {
    assertPollDefault(
      `desktop unit ${branch}`,
      await resolvePollDefaults({ config: false }, createDesktopUnitConfig(options))
    );
  }
});

test('agent-host coverage, unit and integration lanes default expect.poll to the scaled budget', async () => {
  // The unit and coverage scripts run the base config.
  assertPollDefault(
    'agent-host base',
    await resolvePollDefaults(fileConfig('packages/agent-host/vitest.config.mts'))
  );
  assertPollDefault(
    'agent-host integration',
    await resolvePollDefaults(fileConfig('packages/agent-host/vitest.integration.config.mts'))
  );
});
