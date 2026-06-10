import type * as shared from '../embedding-worker-renderer.shared';
import * as database from './database-fixture';
import * as electronApp from './electron-app-fixture';
import * as embeddingAssertions from './embedding-assertions';
import * as embeddingHost from './embedding-host-fixture';
import * as filesystem from './filesystem-fixture';
import * as logs from './log-assertions';

export const fixtureImportContract = [
  electronApp.launchElectronDevAppInTest satisfies typeof shared.launchElectronDevAppInTest,
  electronApp.waitForTcpPortOpen satisfies typeof shared.waitForTcpPortOpen,
  electronApp.withTemporaryProcessEnv satisfies typeof shared.withTemporaryProcessEnv,
  embeddingHost.getEmbeddingHostStatus satisfies typeof shared.getEmbeddingHostStatus,
  embeddingHost.waitForEmbeddingHostState satisfies typeof shared.waitForEmbeddingHostState,
  embeddingHost.ensureEmbeddingHostWarmed satisfies typeof shared.ensureEmbeddingHostWarmed,
  filesystem.installLargeImportFileSystemMock satisfies typeof shared.installLargeImportFileSystemMock,
  filesystem.getMainProcessFileSystemFixtureSummary satisfies typeof shared.getMainProcessFileSystemFixtureSummary,
  database.createTestBackfillJob satisfies typeof shared.createTestBackfillJob,
  database.getEmbeddingQueueStats satisfies typeof shared.getEmbeddingQueueStats,
  database.getEmbeddingSetCounts satisfies typeof shared.getEmbeddingSetCounts,
  embeddingAssertions.assertToolsPanelResponsive satisfies typeof shared.assertToolsPanelResponsive,
  embeddingAssertions.waitForImportedChunks satisfies typeof shared.waitForImportedChunks,
  embeddingAssertions.waitForEmbeddedCollectionSummary satisfies typeof shared.waitForEmbeddedCollectionSummary,
  logs.extractUnexpectedLifecycleLogs satisfies typeof shared.extractUnexpectedLifecycleLogs,
  logs.parseMainProcessHealthSamples satisfies typeof shared.parseMainProcessHealthSamples,
  logs.assertCleanBackfillMeasurementScenario satisfies typeof shared.assertCleanBackfillMeasurementScenario,
] satisfies readonly unknown[];
