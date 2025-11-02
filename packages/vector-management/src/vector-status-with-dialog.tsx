import { EmbeddingSetsRepository, usePGliteDatabase } from '@brainstrike/db';
import { useMemo, useState } from 'react';
import { ManageEmbeddingSetsDialog } from './embedding-set-management';
import { VectorStatusWithDb } from './vector-status';

/**
 * Wrapper component that adds the ManageEmbeddingSetsDialog to VectorStatusWithDb.
 * This is separated to avoid circular dependency issues with @brainstrike/db imports.
 */
export function VectorStatusWithDialog() {
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const db = usePGliteDatabase();
  const repository = useMemo(() => (db ? new EmbeddingSetsRepository(db as never) : null), [db]);

  return (
    <>
      <VectorStatusWithDb onManageEmbeddingSets={() => setManageDialogOpen(true)} />
      {/* Dialog will only mount when opened */}
      {manageDialogOpen && (
        <ManageEmbeddingSetsDialog
          open={manageDialogOpen}
          onOpenChange={setManageDialogOpen}
          db={db as never}
          repository={repository}
          onSetSelected={() => {
            setManageDialogOpen(false);
          }}
        />
      )}
    </>
  );
}
