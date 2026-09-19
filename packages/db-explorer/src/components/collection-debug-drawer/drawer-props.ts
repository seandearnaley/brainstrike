import type {
  DrizzleFileRecordRepository,
  ElectronFileRecordRepository,
  IFileChunkRepository,
} from '@brainstrike/db';
import type { DatabaseFileRecordSummary } from '../../use-database-demo-data';
import type { CollectionSystemRole } from './drawer-model';

export interface DrawerRecordPagination {
  currentPage: number;
  pageSize: number;
  totalPages: number;
  totalRecords: number;
}

export interface CollectionDebugDrawerProps {
  readonly activeCollectionId: string | null;
  readonly activeCollectionSystemRole: CollectionSystemRole;
  readonly chunkRepository: IFileChunkRepository | null;
  /**
   * The PGlite/Electron database context. Typed `unknown` because the context
   * union does not always carry `query`; the drawer narrows it explicitly (and
   * throws when it cannot) in `asDrawerQueryable`.
   */
  readonly database: unknown;
  readonly fileRepository: DrizzleFileRecordRepository | ElectronFileRecordRepository | null;
  /** Updates the panel-owned page that produced `records` and `recordPagination`. */
  readonly onRecordPageChange: (page: number) => void;
  /**
   * The page of collection files already materialized by the panel's live
   * query. The drawer deliberately does NOT open a second file-list
   * subscription — it renders the page the panel already holds.
   */
  readonly recordPagination: DrawerRecordPagination;
  readonly records: readonly DatabaseFileRecordSummary[];
}
