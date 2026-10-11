import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import { _electron as electron } from 'playwright';
import {
  closeModelProviderShimWithProcess,
  resolveProviderEgressEnvironment,
  startModelProviderShim,
} from './model-provider-shim';
export const PACKAGED_DESKTOP_INHERITED_ENV_KEYS = Object.freeze([
  'APPDATA',
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'GNOME_KEYRING_CONTROL',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'LOGNAME',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'WINDIR',
  'XAUTHORITY',
  'XDG_CONFIG_HOME',
  'XDG_CURRENT_DESKTOP',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
] as const);
export function packagedDesktopExecutablePath(): string {
  const releaseRoot = path.resolve(process.cwd(), 'release');
  if (process.platform === 'darwin') {
    const directory = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
    return path.join(
      releaseRoot,
      directory,
      'BrainStrike Desktop.app/Contents/MacOS/BrainStrike Desktop'
    );
  }
  if (process.platform === 'win32') {
    const directory = process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked';
    return path.join(releaseRoot, directory, 'BrainStrike Desktop.exe');
  }
  if (process.platform === 'linux') {
    const directory = process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked';
    return path.join(releaseRoot, directory, 'brainstrike-desktop');
  }
  throw new Error(`Packaged desktop verifier does not support ${process.platform}`);
}
function inheritedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of PACKAGED_DESKTOP_INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}
export async function launchPackagedDesktop(options: {
  readonly environment?: Readonly<Record<string, string>>;
  readonly userDataDir: string;
}): Promise<{
  readonly app: ElectronApplication;
  readonly window: Page;
  readonly process: ChildProcess;
  readonly exited: Promise<void>;
}> {
  // Every launch has a provider egress boundary (BST-1931), owned by this app.
  const boundary = await startModelProviderShim();
  let app: ElectronApplication;
  try {
    app = await launchWithEgressBoundary(
      options,
      resolveProviderEgressEnvironment(boundary, [options.environment ?? {}])
    );
  } catch (error) {
    await boundary.close();
    throw error;
  }
  const child = app.process();
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
    } else {
      child.once('exit', () => resolve());
    }
  });
  closeModelProviderShimWithProcess(boundary, child);
  const window = await app.firstWindow({ timeout: 60_000 });
  await window.waitForLoadState('domcontentloaded');
  return { app, exited, process: child, window };
}
function launchWithEgressBoundary(
  options: {
    readonly environment?: Readonly<Record<string, string>>;
    readonly userDataDir: string;
  },
  providerEgressEnv: Readonly<Record<string, string>>
): Promise<ElectronApplication> {
  return electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : []),
      '--test-mode',
      `--user-data-dir=${options.userDataDir}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
    env: {
      ...inheritedEnvironment(),
      ...options.environment,
      ...providerEgressEnv,
      ['BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES']: '1',
      ['BRAINSTRIKE_E2E_USER_DATA_DIR']: options.userDataDir,
      ['BRAINSTRIKE_OPENAI_API_KEY']: 'test-api-key-for-e2e-tests',
      ['ELECTRON_IS_E2E_TEST']: 'true',
      ['NODE_OPTIONS']: '',
    },
    executablePath: packagedDesktopExecutablePath(),
    timeout: 120_000,
  });
}
export async function closePackagedDesktop(context: {
  readonly app: Pick<ElectronApplication, 'close'>;
  readonly process: Pick<ChildProcess, 'exitCode' | 'signalCode'>;
  readonly exited: Promise<void>;
}): Promise<void> {
  const child = context.process;
  // Playwright may already have disposed its application channel after quit.
  // The launcher retains the physical child and exit join before that happens.
  if (child.exitCode === null && child.signalCode === null) {
    try {
      await context.app.close();
    } finally {
      await context.exited;
    }
  } else {
    await context.exited;
  }
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw new Error(
      `Packaged desktop did not exit gracefully (code=${child.exitCode}, signal=${child.signalCode})`
    );
  }
}
