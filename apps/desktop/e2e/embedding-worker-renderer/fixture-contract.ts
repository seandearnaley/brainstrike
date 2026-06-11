import type * as shared from '../embedding-worker-renderer.shared';
import * as electronApp from './electron-app-fixture';

export const fixtureImportContract = [
  electronApp.launchElectronDevAppInTest satisfies typeof shared.launchElectronDevAppInTest,
  electronApp.closeElectronAppInTest satisfies typeof shared.closeElectronAppInTest,
  electronApp.reloadRendererInTest satisfies typeof shared.reloadRendererInTest,
  electronApp.waitForAppReadyInTest satisfies typeof shared.waitForAppReadyInTest,
  electronApp.getHybridSearchBox satisfies typeof shared.getHybridSearchBox,
  electronApp.getBufferedElectronOutputInTest satisfies typeof shared.getBufferedElectronOutputInTest,
  electronApp.isDisposedElectronEvaluateError satisfies typeof shared.isDisposedElectronEvaluateError,
  electronApp.waitForTcpPortOpen satisfies typeof shared.waitForTcpPortOpen,
  electronApp.withTemporaryProcessEnv satisfies typeof shared.withTemporaryProcessEnv,
] satisfies readonly unknown[];
