import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  shutdownChildProcessTree,
  signalProcessGroup,
} from '../apps/desktop/scripts/start-agent-devtools-session.mjs';

const STORAGE_KEY = 'appimage-qualification-marker';
const PROVIDER = 'appimage-qualification';

export async function runLifecycleStages({ previous, candidate, launch, report, signal }) {
  for (const [name, artifact, seed] of [
    ['first-launch', previous, true],
    ['previous-restart', previous, false],
    ['replacement-launch', candidate, false],
    ['candidate-restart', candidate, false],
  ]) {
    signal?.throwIfAborted();
    const session = await launch(artifact);
    let checkError;
    let result;
    try {
      result = await session.check(seed);
    } catch (error) {
      checkError = error;
    }
    try {
      await session.close();
    } catch (error) {
      throw new AggregateError(
        [checkError, error].filter(Boolean),
        'AppImage session cleanup failed; lifecycle is not qualified.'
      );
    }
    if (checkError) {
      throw checkError;
    }
    report.checks.push({ evidence: result, name, status: 'passed' });
  }
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

export async function waitForDebugEndpoint(
  child,
  port,
  { signal, spawnError = () => null, timeoutMs = 120_000 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  const endpoint = `http://127.0.0.1:${port}`;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (spawnError()) {
      throw new Error('AppImage process could not be started.');
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        'AppImage exited before desktop readiness. Check FUSE, display, and sandbox prerequisites.'
      );
    }
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return endpoint;
      }
    } catch {
      // Readiness polling is bounded by both the request timeout and process lifetime.
    }
    await delay(100, undefined, { signal });
  }
  throw new Error(
    'AppImage did not expose its loopback debug endpoint before the readiness deadline.'
  );
}

async function bounded(operation, milliseconds, signal) {
  signal?.throwIfAborted();
  let timer;
  let abort;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('AppImage operation exceeded its deadline.')),
      milliseconds
    );
    abort = () => reject(new Error('Qualification interrupted.'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function stopProcess(child, report) {
  if (!child.pid) {
    return; // An unsuccessful spawn has no process tree to reap.
  }
  let graceful = child.exitCode === 0;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    signalProcessGroup(child.pid, 'SIGTERM');
    try {
      const [code] = await bounded(exited, 20_000);
      graceful = code === 0;
    } catch {
      graceful = false;
    }
  }
  try {
    // The AppImage runtime can fork. Always reap the owned detached group,
    // including when its direct child exited before one of its descendants.
    await shutdownChildProcessTree(child, 'linux');
  } catch (error) {
    report.profileCleanupAllowed = false;
    throw error;
  }
  assert.ok(graceful, 'AppImage did not shut down gracefully; preservation is unqualified.');
}

export async function inspectSandboxArguments(browser, child) {
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const main = processInfo.find((entry) => entry.type === 'browser');
    assert.ok(Number.isSafeInteger(main?.id) && main.id > 0, 'Main process identity unavailable.');
    const stat = await readFile(`/proc/${main.id}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    assert.equal(
      Number(fields[2]),
      child.pid,
      'CDP endpoint does not belong to the launched AppImage.'
    );
    const args = (await readFile(`/proc/${main.id}/cmdline`, 'utf8')).split('\0');
    assert.ok(
      !args.some((arg) =>
        /^--(?:no-sandbox|disable-setuid-sandbox|disable-namespace-sandbox)(?:=|$)/u.test(arg)
      ),
      'AppImage launcher disabled Chromium sandboxing.'
    );
    return { sandboxBypassArguments: false };
  } finally {
    await session.detach();
  }
}

export async function inspectProfile(page, { seed, marker, root }) {
  // Retain the source promise as well as its completion: Electron's V8 inspector
  // weakly owns awaited evaluation results (same pattern as assistant-mock.ts).
  const pending = await page.evaluateHandle(
    ({ shouldSeed, expected, profile, key, provider }) => {
      const operation = async () => {
        const storage = globalThis.electronAPI?.storage;
        const secrets = globalThis.secrets;
        if (
          !(
            typeof storage?.getItem === 'function' &&
            typeof storage?.setItem === 'function' &&
            typeof secrets?.getKey === 'function' &&
            typeof secrets?.saveKey === 'function' &&
            typeof globalThis.electronAPI?.getUserDataPath === 'function'
          )
        ) {
          throw new Error('Production storage and secrets bridges are required.');
        }
        if ((await globalThis.electronAPI.getUserDataPath()) !== profile) {
          throw new Error('Application profile isolation was not honored.');
        }
        if (shouldSeed) {
          if ((await storage.getItem(key)) !== null || (await secrets.getKey(provider)) !== null) {
            throw new Error('First launch did not start with empty qualification state.');
          }
          await storage.setItem(key, expected);
          const saved = await secrets.saveKey(provider, expected);
          if (saved !== true) {
            throw new Error(
              'Secure credential persistence unavailable; unlock a supported OS keyring.'
            );
          }
        }
        if (
          (await storage.getItem(key)) !== expected ||
          (await secrets.getKey(provider)) !== expected
        ) {
          throw new Error('Application data or synthetic credential was not preserved.');
        }
        return {
          credentialPreserved: true,
          storagePreserved: true,
          userAgent: navigator.userAgent,
        };
      };
      const write = operation();
      const completion = write.then(
        (value) => ({ ok: true, value }),
        () => ({ message: 'Production profile bridge operation failed.', ok: false })
      );
      return { completion, write };
    },
    {
      expected: marker,
      key: STORAGE_KEY,
      // This legacy-named bridge returns the database dataDir, not Electron userData.
      profile: path.join(root, 'database', 'profiles', 'appimage-qualification', 'pgdata'),
      provider: PROVIDER,
      shouldSeed: seed,
    }
  );
  try {
    return await pending.evaluate(async ({ completion }) => {
      const result = await completion;
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.value;
    });
  } finally {
    await pending.dispose();
  }
}

async function launchSession({
  artifact,
  options,
  root,
  marker,
  buildLaunch,
  chromium,
  report,
  signal,
}) {
  const port = await availablePort();
  const launch = buildLaunch({ artifact, inherited: process.env, mode: options.mode, port, root });
  const child = spawn(launch.command, launch.args, {
    cwd: root,
    detached: true,
    env: launch.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Drain without publishing application logs or synthetic credential values.
  child.stderr.resume();
  let spawnFailure;
  child.on('error', (error) => {
    spawnFailure = error;
  });
  let browser;
  const close = async () => {
    try {
      if (browser) {
        await bounded(browser.close(), 5000);
      }
    } finally {
      await stopProcess(child, report);
    }
  };
  try {
    const endpoint = await waitForDebugEndpoint(child, port, {
      signal,
      spawnError: () => spawnFailure,
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    await inspectSandboxArguments(browser, child);
    const context = browser.contexts()[0];
    assert.ok(context, 'AppImage browser context is missing.');
    let page;
    const deadline = Date.now() + 120_000;
    while (!page && Date.now() < deadline) {
      signal?.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('AppImage exited before its main navigation was ready.');
      }
      for (const candidate of context.pages()) {
        if (
          await candidate
            .getByRole('navigation', { exact: true, name: 'Main navigation' })
            .isVisible()
        ) {
          page = candidate;
          break;
        }
      }
      if (!page) {
        await delay(100, undefined, { signal });
      }
    }
    assert.ok(page, 'AppImage main navigation did not become ready.');
    return {
      check: (seed) => bounded(inspectProfile(page, { marker, root, seed }), 30_000, signal),
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'AppImage startup failed and cleanup did not complete normally.'
      );
    }
    throw error;
  }
}

export async function qualifyAppImageLifecycle({ options, root, report, buildLaunch, signal }) {
  const { chromium } = await import('@playwright/test');
  const marker = `synthetic-appimage-qa-${randomUUID()}`;
  await runLifecycleStages({
    candidate: report.candidate.path,
    launch: (artifact) =>
      launchSession({ artifact, buildLaunch, chromium, marker, options, report, root, signal }),
    previous: report.previous.path,
    report,
    signal,
  });
  const encryptedFile = await readFile(
    path.join(root, 'profile', 'brainstrike-secrets.json'),
    'utf8'
  );
  assert.ok(!encryptedFile.includes(marker), 'Synthetic credential was stored in plaintext.');
  assert.ok(JSON.parse(encryptedFile).secrets[PROVIDER], 'Encrypted credential was not persisted.');
  report.checks.push({ name: 'encrypted-at-rest', status: 'passed' });
}
