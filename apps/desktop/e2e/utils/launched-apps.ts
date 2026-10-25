import path from 'node:path';
import type { ElectronApplication } from 'playwright';

/** Each launched app, by the user-data directory it was launched with. */
const launchedApps = new Map<string, ElectronApplication>();

/** Called by every E2E launcher, so readers can reach the app's host through its window. */
export function registerLaunchedApp(userDataDir: string, app: ElectronApplication): void {
  launchedApps.set(path.resolve(userDataDir), app);
}
export function launchedApp(userDataDir: string): ElectronApplication | undefined {
  return launchedApps.get(path.resolve(userDataDir));
}
