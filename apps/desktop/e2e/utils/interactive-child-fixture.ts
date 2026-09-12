import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';

interface InteractiveChildFixtureOptions<Window> {
  readonly captureFailure: (window: Window) => Promise<void>;
  readonly closeProvider: () => Promise<void>;
  readonly electron: {
    ensureContext(): Promise<{ app: { process(): ChildProcess } }>;
    ensureWindow(): Promise<Window>;
    dispose(): Promise<void>;
  };
  readonly environment: Readonly<Record<string, string>>;
  readonly run: (window: Window) => Promise<void>;
  readonly workspace: string;
}

/** Owns the interactive decision fixture's environment, diagnostics and teardown. */
export async function runInteractiveChildFixture<Window>({
  captureFailure,
  closeProvider,
  electron,
  environment,
  run,
  workspace,
}: InteractiveChildFixtureOptions<Window>): Promise<void> {
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  const failures: unknown[] = [];
  let ownedProcess: ChildProcess | undefined;
  let window: Window | undefined;
  const settle = async (step: () => void | Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    const context = await electron.ensureContext();
    // Capture before disposal invalidates Playwright's ElectronApplication.
    ownedProcess = context.app.process();
    window = await electron.ensureWindow();
    await run(window);
  } catch (error) {
    failures.push(error);
    if (window !== undefined) {
      const failedWindow = window;
      await settle(() => captureFailure(failedWindow));
    }
  }

  // Observe exit before requesting disposal: Playwright's close can resolve
  // before the owned process exits. Keep the existing five-second exit bound.
  const results = await Promise.allSettled([
    Promise.resolve().then(() => electron.dispose()),
    ownedProcess ? waitForOwnedExit(ownedProcess) : Promise.resolve(),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      failures.push(result.reason);
    }
  }
  await settle(closeProvider);
  await settle(() => {
    for (const key of Object.keys(environment)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  await settle(async () => {
    if (!ownedProcess || (ownedProcess.exitCode === null && ownedProcess.signalCode === null)) {
      throw new Error(
        `Electron exit is unconfirmed; retained interactive fixture workspace: ${workspace}`
      );
    }
    await rm(workspace, { force: true, recursive: true });
  });
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Interactive child scenario, diagnostics or cleanup failed',
      {
        cause: failures[0],
      }
    );
  }
}

async function waitForOwnedExit(ownedProcess: ChildProcess): Promise<void> {
  if (ownedProcess.exitCode === null && ownedProcess.signalCode === null) {
    await once(ownedProcess, 'exit', { signal: AbortSignal.timeout(5000) });
  }
  if (ownedProcess.exitCode !== 0) {
    throw new Error(
      `Interactive fixture Electron exited with code=${ownedProcess.exitCode}, signal=${ownedProcess.signalCode}`
    );
  }
}
