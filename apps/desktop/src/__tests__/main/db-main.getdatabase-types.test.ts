import type { FileChunkDatabase } from '@brainstrike/db';
import { describe, expectTypeOf, it } from 'vitest';
import type { ReindexDatabaseHandle } from '../../assistant-server/reindex-edited-file';
import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';
import type { RemoteDbClient } from '../../db-host-manager';
import type { DesktopDatabase, getDatabase } from '../../db-main';

describe('getDatabase return typing', () => {
  it('exposes DesktopDatabase as the remote DB client surface', () => {
    expectTypeOf<DesktopDatabase>().toEqualTypeOf<RemoteDbClient>();
    expectTypeOf<typeof getDatabase>().returns.resolves.toEqualTypeOf<DesktopDatabase>();
  });

  it('is assignable to assistant-tool and repository handles without casts', () => {
    expectTypeOf<DesktopDatabase>().toMatchTypeOf<FileChunkDatabase>();
    expectTypeOf<DesktopDatabase>().toMatchTypeOf<ReindexDatabaseHandle>();
    expectTypeOf<DesktopDatabase>().toMatchTypeOf<WorkspaceRootsQueryable>();
  });
});
