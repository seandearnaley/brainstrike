import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceRootRegistry } from '@brainstrike/assistant-service/node-workspace-services';
import { RootLock } from '@brainstrike/state-store';
import { app, utilityProcess } from 'electron';
import { createDesktopWorkspaceRootCatalog } from '../../agent-host-platform/workspace-root-client';
import { createDesktopProfileRuntime } from '../../desktop-profile-runtime';
import { createDesktopHostLease } from '../../host-lease-manager';
import {
  createDesktopGracefulShutdown,
  DESKTOP_SHUTDOWN_SLOW_STEP_MS,
  type DesktopShutdownStepName,
  type DesktopShutdownStepRun,
} from '../../main/desktop-graceful-shutdown';
import { prepareMainCatalogClose } from '../../main/main-catalog-close';
import { createNativeIndexLifecycle } from '../../native-index-lifecycle-owner';
import { createNativeIndexProfileAdmission } from '../../native-index-profile-admission';
import { createNativeIndexRuntime } from '../../native-index-runtime';

const [mode, directory, kernel, method, bundleDirectory] = process.argv.slice(2);
assert.ok(directory && bundleDirectory && (kernel === 'owned' || kernel === 'attached'));
assert.ok(mode === 'ack-first' || mode === 'held' || mode === 'rejected' || mode === 'stuck');
assert.ok(method === 'workspaceRoots' || method === 'worktreeLedger');
const proofDirectory = directory;
const root = join(proofDirectory, 'profile');
const workspace = join(proofDirectory, 'workspace');
const secondWorkspace = join(proofDirectory, 'second-workspace');
const rootId = 'b5f5883e-c414-485a-9c1b-1b43a579ca10';
const secondRootId = '05bca9c7-7cb6-40ef-8204-4d04fbd46b09';
const events: Array<{ event: string; elapsedMs: number; detail?: unknown }> = [];
const started = performance.now();
const event = (name: string, detail?: unknown): void => {
  events.push({ detail, elapsedMs: performance.now() - started, event: name });
};
const unused = async (): Promise<never> => {
  throw new Error('No inference or indexing allowed in the catalog fixture');
};
let childPid: number | undefined;
let childExit: number | undefined;
const lease = createDesktopHostLease({
  entryPath: join(bundleDirectory, 'agent-host-entry.js'),
  fork: (entry, args) => {
    const child = utilityProcess.fork(entry, [...args], {
      serviceName: 'Main catalog close proof',
    });
    child.once('spawn', () => {
      childPid = child.pid;
      event('utility-spawn', childPid);
    });
    child.once('exit', (code) => {
      childExit = code;
      event('utility-exit', code);
    });
    return child;
  },
  platformModule: join(bundleDirectory, 'main-catalog-platform.js'),
  root,
});
const profile = createDesktopProfileRuntime(() => lease);
const runtime = createNativeIndexRuntime({
  admitProfile: (signal) => admission.acquire(signal),
  closeQueries: async () => undefined,
  createIndexOwner: unused,
  getAuthority: unused,
  getFileInvalidator: () => undefined,
  installQueryTarget: () => undefined,
  profile,
});
const lifecycle = createNativeIndexLifecycle(
  { generation: 0, kind: 'idle' },
  {
    execute: unused,
    fence: () => undefined,
  }
);
const admission = createNativeIndexProfileAdmission(lifecycle, runtime, () => {
  throw new Error('The catalog fixture has no index to open.');
});
const catalog = createDesktopWorkspaceRootCatalog(() => admission.acquire());
let registry: WorkspaceRootRegistry | undefined;
let registeredAck = false;
let operationSettled = false;
let operationFailed = false;
let shutdownSettled = false;
let forcedExit: number | undefined;

async function main(): Promise<void> {
  await app.whenReady();
  await mkdir(workspace, { recursive: true });
  await mkdir(secondWorkspace, { recursive: true });
  const attachment = await admission.acquire();
  if (kernel === 'owned') {
    assert.equal(childPid, attachment.record.pid);
  } else {
    assert.equal(childPid, undefined, 'attaching must never fork another utility');
  }
  const identity = {
    hostVersion: attachment.record.hostVersion,
    pid: attachment.record.pid,
    protocolVersion: attachment.record.protocolVersion,
    start: attachment.record.start,
  };
  event('attached', identity);
  for (const [path, id] of [
    [workspace, rootId],
    [secondWorkspace, secondRootId],
  ] as const) {
    await catalog.workspaceRoots({
      operation: 'register',
      root: { displayName: 'workspace', path, preferredId: id },
    });
  }
  await catalog.workspaceRoots({ mountedPaths: [], operation: 'disconnect-except' });
  const storage = new Map([
    [
      'rootsList',
      JSON.stringify([
        { addedAt: 1, path: workspace, rootId },
        { addedAt: 2, path: secondWorkspace, rootId: secondRootId },
      ]),
    ],
  ]);
  const roots = new WorkspaceRootRegistry({
    disposeCommandSessionsForRoot: async () => 0,
    evictLspServersForRoot: async () => undefined,
    getRootsCatalog: async () => ({
      workspaceRoots: async (request) => {
        const result = await catalog.workspaceRoots(request);
        if (request.operation === 'register' && request.root.path === workspace) {
          registeredAck = true;
          event('registration-ack');
        }
        return result;
      },
    }),
    pathExists: async (file) => existsSync(file),
    storage: {
      getItem: async (key) => storage.get(key) ?? null,
      removeItem: async (key) => {
        storage.delete(key);
      },
      setItem: async (key, value) => {
        storage.set(key, value);
      },
    },
  });
  registry = roots;
  await writeFile(join(root, method === 'workspaceRoots' ? 'gate-armed' : 'ledger-armed'), 'armed');
  if (mode === 'rejected') {
    await writeFile(join(root, 'gate-rejected'), 'expected rejection');
  }
  const operation = (
    method === 'worktreeLedger'
      ? catalog.worktreeLedger({ operation: 'list-active' })
      : mode === 'rejected'
        ? catalog.workspaceRoots({
            operation: 'register',
            root: { displayName: 'workspace', path: workspace, preferredId: rootId },
          })
        : roots.restoreRoots()
  ).then(
    () => {
      operationSettled = true;
      event('operation-fulfilled');
    },
    (cause: unknown) => {
      operationSettled = true;
      operationFailed = true;
      event('operation-rejected', String(cause));
    }
  );
  const receipt = join(root, 'register-committed.json');
  const gateDeadline = performance.now() + 5000;
  while (!existsSync(receipt)) {
    assert.ok(
      performance.now() < gateDeadline,
      'real canonical request never reached its response gate'
    );
    await delay(5);
  }
  const committed: unknown = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(operationSettled, false);
  event('committed-response-held', committed);
  const step =
    (name: DesktopShutdownStepName): DesktopShutdownStepRun =>
    async () => {
      event('step-start', name);
      if (name === 'main-catalog') {
        await prepareMainCatalogClose(roots, null, catalog);
      }
      if (name === 'native-index') {
        await runtime.retireProfile();
      }
      if (name === 'file-system') {
        await roots.dispose();
      }
      event('step-finish', name);
    };
  const shutdown = createDesktopGracefulShutdown({
    exitProcess: (code) => {
      forcedExit = code;
      event('forced-exit', code);
    },
    logger: {
      error: (message, detail) => event('shutdown-error', { detail, message }),
      info: (message, detail) => event('shutdown-info', { detail, message }),
      warn: (message, detail) => event('shutdown-warning', { detail, message }),
    },
    markShuttingDown: () => event('shutdown-marked'),
    planRun: () => ({
      closeDatabase: async () => {
        await runtime.retireProfile();
      },
      closeErrorLogSink: () => event('error-log-closed'),
      steps: {
        'child-processes': step('child-processes'),
        'chunking-host': step('chunking-host'),
        'database-drain': step('database-drain'),
        'embedding-host': step('embedding-host'),
        'factory-reset': step('factory-reset'),
        'file-system': step('file-system'),
        forge: step('forge'),
        'git-commands': step('git-commands'),
        'git-inventory': step('git-inventory'),
        'main-catalog': step('main-catalog'),
        'mcp-runtime': step('mcp-runtime'),
        'native-index': step('native-index'),
        'notes-vault': step('notes-vault'),
        'parser-host': step('parser-host'),
        renderers: step('renderers'),
        'snapshot-maintenance': step('snapshot-maintenance'),
      },
    }),
    retireBackgroundAdmission: () => admission.fenceTerminal(),
  });
  if (mode === 'ack-first') {
    await writeFile(join(root, 'gate-released'), 'ACK first');
    await operation;
  }
  const closing = shutdown.run('before-quit').then(() => {
    shutdownSettled = true;
  });
  if (mode === 'held' || mode === 'rejected') {
    await delay(150);
    assert.equal(operationSettled, false, 'an admitted response must remain pending until its ACK');
    assert.equal(shutdownSettled, false);
    assert.equal(childExit, undefined);
    assert.equal(RootLock.isFlockHeld(root), true);
    event('still-pending-before-release');
    await writeFile(join(root, 'gate-released'), 'release after close preparation');
  }
  if (mode === 'stuck') {
    // ADR-0026 R4: a response held past the step deadline Main used to race (10 s
    // [5 s]) and past the slow-step report is still joined; nothing forces an exit.
    await delay(DESKTOP_SHUTDOWN_SLOW_STEP_MS + 1000);
    assert.equal(operationSettled, false, 'a held response stays joined past the old deadline');
    assert.equal(shutdownSettled, false);
    assert.equal(childExit, undefined);
    event('still-pending-past-old-deadline');
    await writeFile(join(root, 'gate-released'), 'release after the old deadline');
  }
  await Promise.all([operation, closing]);
  assert.equal(forcedExit, undefined);
  if (mode === 'stuck') {
    const slow = events.find((item) => item.event === 'shutdown-warning');
    const logged = slow?.detail;
    assert.ok(logged && typeof logged === 'object' && 'message' in logged && 'detail' in logged);
    assert.equal(logged.message, 'Graceful shutdown step is slow');
    const fields = logged.detail;
    assert.ok(fields && typeof fields === 'object' && 'step' in fields);
    assert.equal(fields.step, 'main-catalog');
  }
  if (kernel === 'owned') {
    assert.equal(childExit, 0);
  } else {
    assert.equal(
      RootLock.isFlockHeld(root),
      true,
      'desktop close must not stop the existing owner'
    );
  }
  if (method === 'workspaceRoots' && mode !== 'rejected' && mode !== 'stuck') {
    assert.equal(registeredAck, true);
  }
  if (mode === 'rejected') {
    assert.ok(events.some((item) => item.event === 'shutdown-warning'));
  } else {
    assert.equal(operationFailed, false);
  }
  await writeFile(
    join(proofDirectory, 'report.json'),
    JSON.stringify(
      {
        childExit: childExit ?? null,
        childPid: childPid ?? null,
        events,
        forcedExit: forcedExit ?? null,
        kernel,
        method,
        mode,
        operationFailed,
        record: identity,
        registeredAck,
      },
      null,
      2
    )
  );
}
app.on('window-all-closed', () => undefined);
main().then(
  () => app.exit(0),
  async (cause: unknown) => {
    event('fixture-failed', String(cause));
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'gate-released'), 'failed fixture cleanup');
      await Promise.allSettled([registry?.dispose(), runtime.retireProfile()]);
      await writeFile(
        join(proofDirectory, 'failure.json'),
        JSON.stringify({ cause: String(cause), events }, null, 2)
      );
    } finally {
      process.stderr.write(`${String(cause)}\n`);
      app.exit(1);
    }
  }
);
