import fs from 'node:fs';
import path from 'node:path';
import type { HostCredentialStoreSelection } from '@brainstrike/host-capabilities/credentials';
import type { HostAttachment } from '@brainstrike/host-lease';
import { createLogger } from '@brainstrike/logging';
import { app, crashReporter, MessageChannelMain, type MessagePortMain } from 'electron';
import { configureAgentDevtoolsCommandLine } from './agent-devtools-config';
import type { HostNativeChildren } from './agent-host-platform/host-native-children';
import { createAgentHostPrivateClients } from './agent-host-private-clients';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import { resolveDevelopmentUserDataPath } from './database-location';
import { desktopCredentialStoreSelection } from './desktop-credential-selection';
import {
  isIsolatedDesktopTestRun,
  resolveDesktopDatabaseLocation,
  resolveDesktopDatabaseProfileDirectory,
} from './desktop-database-location';
import { getDesktopEnvironmentBootstrapResult } from './desktop-env';
import { createDesktopProfileRuntime, type DesktopProfileRuntime } from './desktop-profile-runtime';
import { isDesktopShuttingDown } from './desktop-shutdown-state';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';
import { resolveFolderCandidatesFromArgv } from './folder-argv';
import { createDesktopHostLease } from './host-lease-manager';
import { lifecycleDelaySeam } from './lifecycle-delay-seam';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { registerPrivilegedSchemes } from './privileged-schemes';
import {
  createWorkspaceOpenQueue,
  enqueueFolderCandidates,
  filterDirectoryOpenCandidates,
} from './workspace-open-queue';

const logger = createLogger('DesktopBootstrap');
const E2E_USER_DATA_DIR_ENV = 'BRAINSTRIKE_E2E_USER_DATA_DIR';
const DEVELOPMENT_APP_NAME = 'BrainStrike Desktop Dev';
/** package.json's `build.appId`, which electron-builder gives the NSIS Start-menu shortcut. */
const WINDOWS_APP_USER_MODEL_ID = 'com.brainstrike.desktop';
type BindPlatform = (
  port: MessagePortMain,
  children: HostNativeChildren
) => { close(): Promise<void> };
interface PendingPlatform {
  bind(binding: BindPlatform): void;
}

export interface DesktopBootstrapRuntime {
  bindPlatform(binding: BindPlatform): void;
  bindSecondInstanceFocus(focus: () => void): void;
  readonly credentialStore: HostCredentialStoreSelection;
  readonly environment: ReturnType<typeof getDesktopEnvironmentBootstrapResult>;
  readonly mainEntryPath: string;
  readonly privateClients: ReturnType<typeof createAgentHostPrivateClients>;
  readonly profile: DesktopProfileRuntime<HostAttachment>;
  readonly singleInstanceLockAcquired: boolean;
  waitForProfileLaunch(acquisition: Promise<HostAttachment>): Promise<void>;
  readonly workspaceOpenQueue: ReturnType<typeof createWorkspaceOpenQueue>;
}
function readExplicitE2eUserDataDir(): string | null {
  const candidate = process.env[E2E_USER_DATA_DIR_ENV]?.trim();
  if (!candidate || candidate.toLowerCase() === 'undefined') {
    return null;
  }
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${E2E_USER_DATA_DIR_ENV} must be an absolute path.`);
  }
  return candidate;
}

function applyExplicitPathIsolation(agentDevtoolsConfig: {
  readonly enabled: boolean;
}): string | undefined {
  const electronE2ETestMode = isElectronE2ETestMode();
  if (!(electronE2ETestMode || agentDevtoolsConfig.enabled)) {
    return;
  }

  const userDataDir = readExplicitE2eUserDataDir();
  if (!userDataDir) {
    if (agentDevtoolsConfig.enabled) {
      throw new Error(`${E2E_USER_DATA_DIR_ENV} is required when Agent DevTools is enabled.`);
    }
    return;
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);

  const logsDir = path.join(userDataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  app.setPath('logs', logsDir);
  return userDataDir;
}

function applyDevelopmentPathIsolation():
  | {
      readonly userData: string;
      readonly singleInstanceLockAcquired: boolean;
    }
  | undefined {
  if (app.isPackaged || isIsolatedDesktopTestRun() || isElectronE2ETestMode()) {
    return;
  }
  // Pin DB/Core first. Changing Electron paths must not change that authority.
  const userData = resolveDevelopmentUserDataPath(resolveDesktopDatabaseLocation());
  // Every ordinary dev profile shares one launch lock, taken before isolation
  // moves userData. Electron retains this lock after setPath below.
  const singleInstanceLockAcquired = app.requestSingleInstanceLock();
  const logs = path.join(userData, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('logs', logs);
  return { singleInstanceLockAcquired, userData };
}

function createDesktopBootstrapRuntime(): DesktopBootstrapRuntime {
  const environment = getDesktopEnvironmentBootstrapResult();
  const agentDevtoolsConfig = configureAgentDevtoolsCommandLine(
    app.commandLine,
    process.env,
    process.argv
  );
  registerPrivilegedSchemes();
  const explicitUserData = applyExplicitPathIsolation(agentDevtoolsConfig);
  const development = explicitUserData ? undefined : applyDevelopmentPathIsolation();
  const userDataDir = explicitUserData ?? development?.userData ?? app.getPath('userData');
  const credentialStore = desktopCredentialStoreSelection(userDataDir);
  // Windows cannot rename Chromium's live files during factory reset. Give
  // its Session owner a separate container in ordinary launches too; reset
  // clears it through Electron before physically purging app-owned files.
  const sessionDataDir = path.join(userDataDir, 'session-data');
  fs.mkdirSync(sessionDataDir, { recursive: true });
  app.setPath('sessionData', sessionDataDir);
  // Crashpad writes a minidump for any process that crashes, into this
  // profile so a dev or test profile never writes into the release one. Upload
  // stays off; factory reset clears the folder with the rest of userData.
  app.setPath('crashDumps', path.join(userDataDir, 'Crashpad'));
  crashReporter.start({ uploadToServer: false });
  // Linux launches the GPU process through Chromium's zygote. A signal to Main's process group
  // (Ctrl+C in a terminal, a tree kill) ends the zygote too, every GPU relaunch then fails, and
  // Chromium aborts Main ("GPU process isn't usable") before shutdown closes the stores. Running
  // the GPU work in Main leaves nothing to relaunch.
  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('in-process-gpu');
  }
  const e2e = isElectronE2ETestMode();
  const singleInstanceLockAcquired =
    development?.singleInstanceLockAcquired ?? (e2e ? true : app.requestSingleInstanceLock());
  // safeStorage names its keychain item "<app name> Safe Storage" once this script
  // has evaluated, so an unpackaged build that seals credentials never reads the
  // release's key. Renamed after the launch lock, whose identity stays the same.
  if (!app.isPackaged && credentialStore.kind === 'sealed-file') {
    app.setName(DEVELOPMENT_APP_NAME);
  }
  // Windows attributes a toast, the update notice included, to the Start-menu
  // shortcut with the same AppUserModelID; without it the toast reads as Electron.
  if (process.platform === 'win32' && app.isPackaged) {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  }
  const mainEntryPath = resolveBundledSiblingPath('Desktop bootstrap', 'main.js');
  const workspaceOpenQueue = createWorkspaceOpenQueue(DESKTOP_IPC_CHANNELS.workspace.openPath);
  let focusSecondInstance: (() => void) | undefined;
  if (singleInstanceLockAcquired) {
    app.on('open-file', (event, openedPath) => {
      event.preventDefault();
      if (isDesktopShuttingDown()) {
        return;
      }
      enqueueFolderCandidates(
        workspaceOpenQueue,
        filterDirectoryOpenCandidates([openedPath], 'open-file'),
        'open-file'
      );
    });
    if (!e2e) {
      app.on('second-instance', (_event, argv, workingDirectory) => {
        if (isDesktopShuttingDown()) {
          return;
        }
        enqueueFolderCandidates(
          workspaceOpenQueue,
          filterDirectoryOpenCandidates(
            resolveFolderCandidatesFromArgv({
              appEntryPath: mainEntryPath,
              appPath: app.getAppPath(),
              argv,
              isPackaged: app.isPackaged,
              workingDirectory,
            }),
            'second-instance'
          ),
          'second-instance'
        );
        focusSecondInstance?.();
      });
    }
  }
  const privateClients = createAgentHostPrivateClients();
  const pending = new Set<PendingPlatform>();
  let binding: BindPlatform | undefined;
  const launched = Promise.withResolvers<void>();
  const profile = createDesktopProfileRuntime((lost) => {
    // Terminal quit never admits a replacement profile, including after reset.
    if (isDesktopShuttingDown()) {
      throw new Error('Desktop profile is shutting down');
    }
    const unbound = new Set<() => void>();
    const lease = createDesktopHostLease({
      lifecycleDelays: lifecycleDelaySeam(),
      onChildReady: privateClients.attach,
      onChildStarted: () => launched.resolve(),
      onLost: ({ requested }) => {
        if (requested) {
          logger.info('The agent host stopped for the restart the user asked for');
        } else {
          logger.warn('The agent host closed without Main asking; the next client relaunches it');
        }
        lost();
      },
      platform: (children) => {
        const channel = new MessageChannelMain();
        let owner: ReturnType<BindPlatform> | undefined;
        const closeUnbound = (): void => {
          pending.delete(platform);
          channel.port1.close();
          channel.port2.close();
          unbound.delete(closeUnbound);
        };
        const platform: PendingPlatform = {
          bind: (bind) => {
            owner = bind(channel.port1, children);
            unbound.delete(closeUnbound);
          },
        };
        unbound.add(closeUnbound);
        if (binding) {
          platform.bind(binding);
        } else {
          pending.add(platform);
        }
        let closing: Promise<void> | undefined;
        return {
          close: () =>
            (closing ??= (async () => {
              pending.delete(platform);
              unbound.delete(closeUnbound);
              try {
                await owner?.close();
              } finally {
                channel.port1.close();
                channel.port2.close();
              }
            })()),
          port: channel.port2,
        };
      },
      platformModule: resolveBundledSiblingPath(
        'Agent host platform',
        'agent-host-platform-entry.js'
      ),
      platformOptions: async () => ({
        appPaths: {
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          userDataPath: app.getPath('userData'),
        },
        credentialStore,
        ...(environment.failures.length > 0 ? { envFileFailures: [...environment.failures] } : {}),
      }),
      root: resolveDesktopDatabaseProfileDirectory(),
    });
    return {
      acquire: lease.acquire,
      clearAndRetireContent: lease.clearAndRetireContent,
      close: (reason?: unknown) => {
        // No Main capabilities were lent on an unbound port. Closing it rejects
        // the utility's queued readiness request before joining startup rollback.
        for (const close of unbound) {
          close();
        }
        return lease.close(reason);
      },
    };
  });
  return {
    bindPlatform: (bind) => {
      if (binding) {
        throw new Error('Desktop platform is already bound');
      }
      if (isDesktopShuttingDown()) {
        throw new Error('Desktop profile is shutting down');
      }
      for (const platform of pending) {
        platform.bind(bind);
        pending.delete(platform);
      }
      binding = bind;
    },
    bindSecondInstanceFocus: (focus) => {
      focusSecondInstance = focus;
    },
    credentialStore,
    environment,
    mainEntryPath,
    privateClients,
    profile,
    singleInstanceLockAcquired,
    waitForProfileLaunch: async (acquisition) => {
      // An existing ready attachment needs no new fork. A new owner must send
      // its lifetime and platform ports before Main evaluation occupies this thread.
      await Promise.race([launched.promise, acquisition]);
    },
    workspaceOpenQueue,
  };
}

let runtime: DesktopBootstrapRuntime | undefined;
/** Both emitted Main modules require this exact CJS module instance. */
export function getDesktopBootstrapRuntime(): DesktopBootstrapRuntime {
  runtime ??= createDesktopBootstrapRuntime();
  return runtime;
}
