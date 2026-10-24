import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { type BuildOptions, build, type Plugin } from 'esbuild';
import {
  E2E_CREDENTIAL_ENV_NAMES,
  type ModelProviderShim,
  resolveProviderEgressEnvironment,
} from './model-provider-shim';

/**
 * Only credentials differ: bootstrap, storage, picker and host are production.
 * `application` must sit inside the desktop package (a test's output folder):
 * its main then resolves the desktop's own node_modules by Node's ordinary
 * parent walk, the way `electron .` does, with no link to follow.
 */
export async function prepareOrdinaryDevApp(application: string): Promise<string> {
  const desktop = path.resolve(import.meta.dirname, '../..');
  const inside = path.relative(desktop, application);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`The ordinary dev app must be built inside ${desktop}: ${application}`);
  }
  await mkdir(application, { recursive: true });
  await cp(path.join(desktop, 'dist'), path.join(application, 'dist'), { recursive: true });
  await cp(path.join(desktop, 'package.json'), path.join(application, 'package.json'));
  await cp(path.join(desktop, 'resources'), path.join(application, 'resources'), {
    recursive: true,
  });
  const configuration: Record<
    'MAIN_PROCESS_BUILD_OPTIONS' | 'AGENT_HOST_PLATFORM_BUILD_OPTIONS',
    BuildOptions
  > = await import(pathToFileURL(path.join(desktop, 'scripts/build-main-config.mjs')).href);
  const credentialModule = path.join(desktop, 'src/desktop-credential-selection.ts');
  const matched = new Set<string>();
  const credentials: Plugin = {
    name: 'ordinary-dev-disposable-credentials',
    setup(builder) {
      builder.onLoad(
        { filter: /[/\\]desktop-credential-selection\.ts$/ },
        ({ path: modulePath }) => {
          if (modulePath !== credentialModule || matched.has(modulePath)) {
            throw new Error('Credential substitution did not identify exactly one module');
          }
          matched.add(modulePath);
          return {
            contents: `import { join } from 'node:path';
            import { app } from 'electron';
            export function desktopCredentialStoreSelection(userData = app.getPath('userData')) {
              return { kind: 'file', path: join(userData, 'brainstrike-credentials.json') };
            }`,
            loader: 'ts',
            resolveDir: path.dirname(modulePath),
          };
        }
      );
    },
  };
  await build({
    ...configuration.MAIN_PROCESS_BUILD_OPTIONS,
    outdir: path.join(application, 'dist'),
    plugins: [...(configuration.MAIN_PROCESS_BUILD_OPTIONS.plugins ?? []), credentials],
  });
  if (matched.size !== 1) {
    throw new Error('Ordinary dev proof did not substitute the credential owner');
  }
  await build({
    ...configuration.AGENT_HOST_PLATFORM_BUILD_OPTIONS,
    outdir: path.join(application, 'dist'),
  });
  return application;
}

export interface OrdinaryDevApp {
  readonly app: ElectronApplication;
  readonly close: () => Promise<void>;
  readonly page: Page;
  readonly userData: string;
}

export interface OrdinaryDevLaunchOptions {
  application: string;
  directory: string;
  profile: string;
  provider: ModelProviderShim;
  rendererUrl: string;
  root: string;
}

export async function ordinaryDevLaunchConfiguration(
  options: OrdinaryDevLaunchOptions
): Promise<{ args: string[]; env: Record<string, string> }> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  for (const name of Object.keys(environment)) {
    if (
      E2E_CREDENTIAL_ENV_NAMES.has(name.toUpperCase()) ||
      name.startsWith('BRAINSTRIKE_E2E') ||
      name.startsWith('BRAINSTRIKE_AGENT_DEVTOOLS') ||
      // The runner's, not dev:electron's: create-window.ts reads CI=true as test mode.
      name === 'CI' ||
      name === 'ELECTRON_IS_E2E_TEST' ||
      name === 'ELECTRON_RUN_AS_NODE'
    ) {
      delete environment[name];
    }
  }
  const home = path.join(options.directory, 'home');
  await mkdir(home, { recursive: true });
  return {
    args: [
      options.application,
      '--no-sandbox', // The ordinary dev:electron command, not an added test policy.
      '--brainstrike-desktop-launch-mode=dev-server',
      `--user-data-dir=${path.join(options.directory, 'shared-launch-user-data')}`,
    ],
    env: {
      ...environment,
      ...resolveProviderEgressEnvironment(options.provider, [environment]),
      ['BRAINSTRIKE_DB_PROFILE']: options.profile,
      ['BRAINSTRIKE_DB_ROOT_PATH']: path.join(options.directory, 'database'),
      ['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']: options.rendererUrl,
      ['HOME']: home,
      ['NODE_ENV']: 'development',
    },
  };
}

export async function launchOrdinaryDevApp(
  options: OrdinaryDevLaunchOptions
): Promise<OrdinaryDevApp> {
  const app = await _electron.launch({
    ...(await ordinaryDevLaunchConfiguration(options)),
    timeout: 60_000,
  });
  const child = app.process();
  const close = async (): Promise<void> => {
    await app.close();
    if (child.exitCode !== 0 || child.signalCode !== null) {
      throw new Error(
        `Ordinary dev app did not join normally: ${child.exitCode}/${child.signalCode}`
      );
    }
  };
  try {
    const userData = await app.evaluate(({ app: electron, dialog, session }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
      session.defaultSession.webRequest.onBeforeRequest((request, reply) => {
        const url = new URL(request.url);
        const internal = [
          'file:',
          'devtools:',
          'chrome:',
          'data:',
          'blob:',
          'about:',
          'brainstrike:',
        ].includes(url.protocol);
        const loopback =
          ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        reply({ cancel: !(internal || loopback) });
      });
      return electron.getPath('userData');
    }, options.root);
    const page = await app.firstWindow();
    await page.waitForFunction(() => Reflect.get(window, '__BRAINSTRIKE_READY__') === true);
    if (
      await page.evaluate(() => {
        const lifecycle: unknown = Reflect.get(window, 'desktopLifecycle');
        return (
          typeof lifecycle === 'object' &&
          lifecycle !== null &&
          Reflect.get(lifecycle, 'isTestMode') === true
        );
      })
    ) {
      throw new Error('Ordinary dev regression accidentally enabled test mode');
    }
    // The ordinary window is shown before its renderer loads. A hidden one is the
    // test-mode window, which Linux renders at one frame per second (BST-2103).
    if (!(await (await app.browserWindow(page)).evaluate((win) => win.isVisible()))) {
      throw new Error('Ordinary dev regression opened the hidden test-mode window');
    }
    return { app, close, page, userData };
  } catch (error) {
    await close();
    throw error;
  }
}
