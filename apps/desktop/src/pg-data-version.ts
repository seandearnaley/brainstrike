// The Node implementation is shared; Desktop retains its existing public surface.
export {
  BUNDLED_PG_MAJOR,
  ENGINE_UPGRADE_BACKUP_RETENTION_MS,
  isEngineUpgradeBackupName,
  isIncompatiblePgDataDir,
  isNewerPgDataDir,
  pruneStaleEngineUpgradeBackups,
  readPgDataMajor,
  readPgWalBytes,
} from '@brainstrike/assistant-service/node-workspace-services';
