#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, open, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectAppImageMetadata,
  inspectArtifact,
  requireUserNamespaces,
} from './qualify-linux-appimage-artifact.mjs';
import { qualifyAppImageLifecycle } from './qualify-linux-appimage-lifecycle.mjs';

const OPTION_KEYS = new Set(['--previous', '--candidate', '--mode', '--output']);
const INHERITED_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'XDG_CURRENT_DESKTOP',
  'LANG',
  'LC_ALL',
  'PATH',
];

export function parseAppImageQualificationArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!OPTION_KEYS.has(key) || values[key] !== undefined || !value || value.startsWith('--')) {
      throw new Error('Use exactly --previous, --candidate, --mode, and --output.');
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== 4 || !['mounted', 'extract'].includes(values['--mode'])) {
    throw new Error('Provide both AppImages and choose mounted or extract explicitly.');
  }
  for (const key of ['--previous', '--candidate', '--output']) {
    if (!path.isAbsolute(values[key]) || values[key].includes('\0')) {
      throw new Error(`${key} must be an absolute path without NUL bytes.`);
    }
  }
  if (path.resolve(values['--previous']) === path.resolve(values['--candidate'])) {
    throw new Error('Previous and candidate must be distinct AppImage artifacts.');
  }
  return {
    candidate: values['--candidate'],
    mode: values['--mode'],
    output: values['--output'],
    previous: values['--previous'],
  };
}

export function buildAppImageLaunch({ artifact, root, port, mode, inherited, temporaryDirectory }) {
  const env = {};
  for (const key of INHERITED_KEYS) {
    if (inherited[key] !== undefined) {
      env[key] = inherited[key];
    }
  }
  Object.assign(env, {
    BRAINSTRIKE_AGENT_DEVTOOLS: '1',
    BRAINSTRIKE_AGENT_DEVTOOLS_HOST: '127.0.0.1',
    BRAINSTRIKE_AGENT_DEVTOOLS_PORT: String(port),
    BRAINSTRIKE_DB_PROFILE: 'appimage-qualification',
    BRAINSTRIKE_DB_ROOT_PATH: path.join(root, 'database'),
    BRAINSTRIKE_E2E_USER_DATA_DIR: path.join(root, 'profile'),
    HOME: path.join(root, 'home'),
    TMPDIR: temporaryDirectory ?? path.join(root, 'tmp'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
  });
  return {
    args: [
      ...(mode === 'extract' ? ['--appimage-extract-and-run'] : []),
      '--brainstrike-agent-devtools',
      '--brainstrike-desktop-launch-mode=built',
    ],
    command: artifact,
    env,
  };
}

async function createTempAlias(root) {
  // Unix-domain sockets have a short path limit. Keep the pathname short while
  // AppImage extraction/cache bytes stay on the chosen disk-backed filesystem.
  const directory = await mkdtemp('/tmp/bs-ai-');
  const temporaryDirectory = path.join(directory, 't');
  try {
    await symlink(path.join(root, 'tmp'), temporaryDirectory, 'dir');
    return { directory, temporaryDirectory };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

async function requireHost() {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() === 0) {
    throw new Error('Run this qualification as a non-root user on Linux x64.');
  }
}

export function requireDisplay(env) {
  if (!(env.DISPLAY || env.WAYLAND_DISPLAY)) {
    throw new Error(
      'A desktop display session (DISPLAY or WAYLAND_DISPLAY) is required. No app launch was attempted.'
    );
  }
}

async function requireFuse() {
  await access('/dev/fuse', constants.R_OK | constants.W_OK).catch(() => {
    throw new Error(
      'Mounted AppImage qualification requires readable/writable /dev/fuse. No extraction fallback was used.'
    );
  });
}

export function describeQualificationFailure(error, depth = 0) {
  const message = error instanceof Error ? error.message : 'AppImage qualification failed.';
  const description = {
    message: message
      .replace(/synthetic-appimage-qa-[a-f0-9-]+/giu, '[synthetic credential]')
      .slice(0, 1000),
    name: error instanceof Error ? error.name : 'Error',
  };
  if (error instanceof AggregateError && depth < 2) {
    description.causes = error.errors
      .slice(0, 4)
      .map((cause) => describeQualificationFailure(cause, depth + 1));
  }
  return description;
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseAppImageQualificationArgs(args);
  await mkdir(path.dirname(options.output), { recursive: true });
  // Reserve BEFORE inspecting or launching either artifact. Never overwrite a
  // prior report, including through a symlink, and keep the report owner-only.
  const output = await open(options.output, 'wx', 0o600);
  const report = {
    checks: [],
    cleanDesktopQualification: 'not-established-by-this-automated-profile-test',
    databaseMigration: 'not-tested-by-storage-marker',
    desktopIntegration: 'manual-clean-desktop-check-required',
    folderPicker: 'manual-clean-desktop-check-required',
    host: { architecture: process.arch, kernel: os.release(), platform: process.platform },
    mode: options.mode,
    sandboxQualification: 'not-established',
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    status: 'incomplete',
    upgradeCoverage: 'artifact-replacement-only',
  };
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Qualification interrupted.'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let root;
  let temporaryAlias;
  let phase = 'host-prerequisites';
  try {
    await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await (dependencies.requireHost ?? requireHost)();
    report.host.osRelease = (await readFile('/etc/os-release', 'utf8'))
      .split('\n')
      .filter((line) => /^(?:ID|VERSION_ID|PRETTY_NAME)=/u.test(line));
    phase = 'artifact-identity';
    report.previous = await (dependencies.inspectArtifact ?? inspectArtifact)(options.previous);
    report.candidate = await (dependencies.inspectArtifact ?? inspectArtifact)(options.candidate);
    if (
      report.previous.path === report.candidate.path ||
      report.previous.sha256 === report.candidate.sha256
    ) {
      throw new Error('Distinct artifact bytes are required; copying one build is not an upgrade.');
    }
    root = await mkdtemp(path.join(path.dirname(options.output), 'appimage-qa-'));
    for (const name of [
      'home',
      'config',
      'data',
      'cache',
      'tmp',
      'profile',
      'previous',
      'candidate',
    ]) {
      await mkdir(path.join(root, name), { mode: 0o700 });
    }
    temporaryAlias = await createTempAlias(root);
    const buildLaunch = (launch) =>
      buildAppImageLaunch({ ...launch, temporaryDirectory: temporaryAlias.temporaryDirectory });
    const { env } = buildLaunch({
      artifact: options.candidate,
      inherited: process.env,
      mode: options.mode,
      port: 9222,
      root,
    });
    phase = 'artifact-metadata';
    for (const name of ['previous', 'candidate']) {
      report[name].metadata = await (dependencies.inspectMetadata ?? inspectAppImageMetadata)({
        artifact: report[name].path,
        directory: path.join(root, name),
        env,
        signal: controller.signal,
      });
    }
    phase = 'launch-prerequisites';
    if (options.mode === 'mounted') {
      await (dependencies.requireFuse ?? requireFuse)();
    }
    await (dependencies.requireUserNamespaces ?? requireUserNamespaces)({
      env,
      signal: controller.signal,
    });
    (dependencies.requireDisplay ?? requireDisplay)(env);
    phase = 'lifecycle';
    await (dependencies.qualifyLifecycle ?? qualifyAppImageLifecycle)({
      buildLaunch,
      options,
      report,
      root,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    const stages = [
      'first-launch',
      'previous-restart',
      'replacement-launch',
      'candidate-restart',
      'encrypted-at-rest',
    ];
    if (
      report.checks.length !== stages.length ||
      stages.some(
        (name, index) =>
          report.checks[index]?.name !== name || report.checks[index]?.status !== 'passed'
      )
    ) {
      throw new Error('Lifecycle did not complete every required check.');
    }
    phase = 'artifact-stability';
    for (const name of ['previous', 'candidate']) {
      const after = await (dependencies.inspectArtifact ?? inspectArtifact)(report[name].path);
      if (after.sha256 !== report[name].sha256 || after.path !== report[name].path) {
        throw new Error(
          'AppImage bytes changed during qualification; recorded hashes are not proof.'
        );
      }
    }
    report.sandboxQualification = 'launch-arguments-checked-not-a-kernel-attestation';
    report.status = 'passed-bounded-lifecycle';
  } catch (error) {
    report.status = 'failed';
    report.failure = { ...describeQualificationFailure(error), phase };
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (report.profileCleanupAllowed === false) {
      report.status = 'failed';
      report.cleanupFailure = 'Process-tree cleanup unconfirmed; disposable profile retained.';
    }
    if (report.profileCleanupAllowed === false) {
      report.retainedProfile = root;
      report.retainedTemporaryAlias = temporaryAlias?.directory;
    } else {
      for (const target of [root, temporaryAlias?.directory].filter(Boolean)) {
        try {
          await (target === root ? (dependencies.removeProfile ?? rm) : rm)(target, {
            force: true,
            recursive: true,
          });
        } catch {
          report.status = 'failed';
          report.cleanupFailure = 'Disposable profile cleanup failed.';
        }
      }
    }
    report.finishedAt = new Date().toISOString();
    try {
      await (
        dependencies.writeReport ??
        (async (handle, data) => {
          await handle.truncate(0);
          await handle.write(data, 0, 'utf8');
        })
      )(output, `${JSON.stringify(report, null, 2)}\n`);
    } finally {
      await output.close();
    }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await main();
    process.exitCode = report.status === 'passed-bounded-lifecycle' ? 0 : 1;
    console.log(`AppImage qualification: ${report.status}. See the requested report.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'AppImage qualification failed.');
    process.exitCode = 1;
  }
}
